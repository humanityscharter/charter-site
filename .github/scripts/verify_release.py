"""Fail-closed checks for an isolated, static Charter site release."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping


BROWSER_FILES = frozenset({
    "00-how-to-propose-an-amendment.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md",
    "GOVERNANCE.md", "LICENSE-CHARTER.md", "LICENSE-CODE.md", "PROPOSALS.md",
    "SETTLED.md", "api-config.js", "app.js", "charter-data.js", "favicon.png",
    "index.html", "logo.png", "markdown-renderer.js", "proposal-client.js",
    "reaction-client.js", "reaction-view.js", "style.css",
})
REPOSITORY_METADATA = frozenset({
    ".github/workflows/pages.yml",
    ".github/workflows/checks.yml",
    ".github/scripts/verify_release.py",
    ".github/scripts/freeze_release.py",
    "release-manifest.json",
})
_HEX_40 = re.compile(r"[0-9a-f]{40}\Z")
_HEX_64 = re.compile(r"[0-9a-f]{64}\Z")
_UTC_TIMESTAMP = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z\Z"
)
_WINDOWS_RESERVED = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _is_reparse(info: os.stat_result) -> bool:
    return bool(getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def _check_entry_type(info: os.stat_result, name: str) -> str:
    if stat.S_ISLNK(info.st_mode) or _is_reparse(info):
        raise ValueError(f"Linked or reparse entry is not allowed: {name}")
    if stat.S_ISDIR(info.st_mode):
        return "directory"
    if stat.S_ISREG(info.st_mode):
        return "file"
    raise ValueError(f"Special filesystem entry is not allowed: {name}")


def _validate_case_names(names) -> None:
    observed: dict[str, str] = {}
    for name in names:
        folded = name.casefold()
        if folded in observed and observed[folded] != name:
            raise ValueError(f"Case-colliding inventory path: {observed[folded]} and {name}")
        observed[folded] = name


def _check_plain_path(path: Path, label: str, allow_missing: bool = False) -> Path:
    path = Path(path).absolute()
    for part in (path, *path.parents):
        try:
            info = part.lstat()
        except FileNotFoundError:
            if allow_missing:
                continue
            raise ValueError(f"Missing {label} path component: {part}") from None
        except OSError as error:
            raise ValueError(f"Cannot inspect {label} path: {part}") from error
        if stat.S_ISLNK(info.st_mode) or _is_reparse(info):
            raise ValueError(f"Linked or reparse {label} path is not allowed: {part}")
        if part == path and not stat.S_ISDIR(info.st_mode):
            raise ValueError(f"{label} must be a real directory: {path}")
    resolved = path.resolve(strict=not allow_missing)
    return resolved


def _canonical_name(name: object) -> str:
    if not isinstance(name, str) or not name or "\\" in name or ":" in name:
        raise ValueError(f"Non-canonical or unsafe relative path: {name!r}")
    if name.startswith("/") or any(ord(char) < 32 or ord(char) == 127 for char in name):
        raise ValueError(f"Absolute or unsafe relative path: {name!r}")
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"Non-canonical or escaped relative path: {name!r}")
    for part in parts:
        if part.endswith((".", " ")) or any(char in part for char in '<>"|?*'):
            raise ValueError(f"Non-portable relative path: {name!r}")
        if part.split(".", 1)[0].casefold() in _WINDOWS_RESERVED:
            raise ValueError(f"Reserved Windows path component: {name!r}")
    return name


def _expectation_items(expected_files) -> dict[str, str]:
    if isinstance(expected_files, Mapping):
        items = list(expected_files.items())
    else:
        try:
            items = list(expected_files)
        except TypeError as error:
            raise ValueError("Expected hash inventory must be a mapping") from error
    result: dict[str, str] = {}
    folded: dict[str, str] = {}
    for raw_name, digest in items:
        name = _canonical_name(raw_name)
        key = name.casefold()
        if key in folded:
            raise ValueError(f"Duplicate or case-colliding expected path: {name}")
        folded[key] = name
        if not isinstance(digest, str) or not _HEX_64.fullmatch(digest):
            raise ValueError(f"Malformed SHA-256 hash for {name}")
        result[name] = digest
    return result


def _walk_inventory(root: Path, allowed_root_git: bool = False) -> tuple[set[str], set[str]]:
    files: set[str] = set()
    directories: set[str] = set()
    case_names: dict[str, str] = {}

    def visit(directory: Path, prefix: str = "") -> None:
        try:
            entries = sorted(os.scandir(directory), key=lambda entry: entry.name.casefold())
        except OSError as error:
            raise ValueError(f"Cannot scan inventory directory: {directory}") from error
        for entry in entries:
            name = f"{prefix}/{entry.name}" if prefix else entry.name
            _canonical_name(name)
            folded = name.casefold()
            if folded in case_names:
                raise ValueError(f"Case-colliding inventory path: {case_names[folded]} and {name}")
            case_names[folded] = name
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError as error:
                raise ValueError(f"Cannot inspect inventory entry: {name}") from error
            kind = _check_entry_type(info, name)
            if kind == "directory":
                if allowed_root_git and name == ".git":
                    continue
                directories.add(name)
                visit(Path(entry.path), name)
            elif kind == "file":
                if allowed_root_git and name == ".git":
                    raise ValueError("A linked gitfile is not an allowed .git directory")
                files.add(name)
            else:
                raise ValueError(f"Special filesystem entry is not allowed: {name}")

    visit(root)
    _validate_case_names(case_names.values())
    return files, directories


def _expected_directories(file_names: set[str]) -> set[str]:
    return {
        "/".join(parts[:index])
        for name in file_names
        for parts in [name.split("/")]
        for index in range(1, len(parts))
    }


def _read_hash(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as error:
        raise ValueError(f"Cannot read file for hash: {path}") from error
    return digest.hexdigest()


def _validate_inventory(root: Path, expected: dict[str, str], *, allow_root_git: bool = False) -> dict[str, str]:
    root = _check_plain_path(root, "root")
    actual_files, actual_dirs = _walk_inventory(root, allowed_root_git=allow_root_git)
    expected_files = set(expected)
    expected_dirs = _expected_directories(expected_files)
    if actual_files != expected_files or actual_dirs != expected_dirs:
        missing = sorted(expected_files - actual_files)
        extra = sorted(actual_files - expected_files)
        missing_dirs = sorted(expected_dirs - actual_dirs)
        extra_dirs = sorted(actual_dirs - expected_dirs)
        raise ValueError(
            "inventory mismatch: "
            f"missing files={missing}; extra files={extra}; "
            f"missing directories={missing_dirs}; extra directories={extra_dirs}"
        )
    actual: dict[str, str] = {}
    for name in sorted(expected_files):
        digest = _read_hash(root.joinpath(*name.split("/")))
        if digest != expected[name]:
            raise ValueError(f"hash mismatch for {name}: expected {expected[name]}, got {digest}")
        actual[name] = digest
    return actual


def validate_site(root: Path, expected_files: dict[str, str]) -> dict[str, str]:
    """Validate the exact 19-file browser tree against independent SHA-256 values."""
    expected = _expectation_items(expected_files)
    if set(expected) != BROWSER_FILES:
        raise ValueError("inventory mismatch: expected browser hash keys must be the reviewed 19-file allowlist")
    return _validate_inventory(Path(root), expected)


def check_candidate(checkout: Path) -> dict[str, str]:
    """Check a candidate site's repository metadata and browser bytes for self-consistency only."""
    source_root = _check_plain_path(Path(checkout), "checkout")
    actual_files, actual_dirs = _walk_inventory(source_root, allowed_root_git=True)
    expected_names = set(BROWSER_FILES) | set(REPOSITORY_METADATA)
    expected_dirs = _expected_directories(expected_names)
    if actual_files != expected_names or actual_dirs != expected_dirs:
        raise ValueError(
            "inventory mismatch: "
            f"missing files={sorted(expected_names - actual_files)}; "
            f"extra files={sorted(actual_files - expected_names)}; "
            f"missing directories={sorted(expected_dirs - actual_dirs)}; "
            f"extra directories={sorted(actual_dirs - expected_dirs)}"
        )
    metadata_hashes = {
        name: _read_hash(source_root.joinpath(*name.split("/")))
        for name in sorted(REPOSITORY_METADATA)
    }
    manifest_bytes = (source_root / "release-manifest.json").read_bytes()
    manifest = _public_manifest(manifest_bytes, metadata_hashes["release-manifest.json"])
    _, browser_hashes = _validate_repository_checkout(
        source_root, manifest["files"], metadata_hashes
    )
    return browser_hashes


def site_tree_sha256(files: dict[str, str]) -> str:
    """Hash sorted ``relative/path<TAB>file-SHA256`` lines, terminated by LF."""
    expected = _expectation_items(files)
    payload = "".join(f"{name}\t{expected[name]}\n" for name in sorted(expected)).encode("utf-8")
    return _sha256(payload)


def _fresh_destination(destination: Path, source_root: Path) -> tuple[Path, Path]:
    destination = Path(destination).absolute()
    parent = destination.parent
    resolved_parent = _check_plain_path(parent, "destination parent")
    target = resolved_parent / destination.name
    if target.exists() or target.is_symlink():
        raise ValueError(f"Upload destination must be fresh and empty: {target}")
    try:
        target.relative_to(source_root)
    except ValueError:
        pass
    else:
        raise ValueError("Upload destination must be outside the source checkout")
    try:
        source_root.relative_to(target)
    except ValueError:
        pass
    else:
        raise ValueError("Upload destination cannot contain the source checkout")
    return target, resolved_parent


def _copy_to_new_destination(source_root: Path, target: Path, expected: dict[str, str]) -> dict[str, str]:
    target.mkdir()
    try:
        for name in sorted(expected):
            source = source_root.joinpath(*name.split("/"))
            output = target.joinpath(*name.split("/"))
            output.parent.mkdir(parents=True, exist_ok=True)
            before = _read_hash(source)
            if before != expected[name]:
                raise ValueError(f"hash mismatch before copy for {name}")
            shutil.copyfile(source, output)
            copied = _read_hash(output)
            after = _read_hash(source)
            if copied != expected[name] or after != expected[name]:
                raise ValueError(f"hash mismatch during copy for {name}")
        return _validate_inventory(target, expected)
    except Exception:
        # The destination is newly created by this operation and is not returned on failure.
        shutil.rmtree(target, ignore_errors=True)
        raise


def _copy_validated(source_root: Path, destination: Path, expected: dict[str, str]) -> dict[str, str]:
    target, _ = _fresh_destination(destination, source_root)
    return _copy_to_new_destination(source_root, target, expected)


def stage_upload(root: Path, destination: Path, expected_files: dict[str, str]) -> dict[str, str]:
    """Copy only a validated browser tree to a new directory outside its source."""
    expected = _expectation_items(expected_files)
    if set(expected) != BROWSER_FILES:
        raise ValueError("inventory mismatch: expected browser hash keys must be the reviewed 19-file allowlist")
    source_root = _check_plain_path(Path(root), "source")
    _validate_inventory(source_root, expected)
    return _copy_validated(source_root, Path(destination), expected)


def _validate_repository_checkout(
    checkout: Path,
    expected_files: dict[str, str],
    expected_metadata: dict[str, str],
) -> tuple[Path, dict[str, str]]:
    browser = _expectation_items(expected_files)
    metadata = _expectation_items(expected_metadata)
    if set(browser) != BROWSER_FILES or set(metadata) != REPOSITORY_METADATA:
        raise ValueError("inventory mismatch: browser and repository metadata roles must match their exact allowlists")
    source_root = _check_plain_path(Path(checkout), "checkout")
    # Inventory allows only an actual root .git directory; all other paths are enumerated and hashed below.
    actual_files, actual_dirs = _walk_inventory(source_root, allowed_root_git=True)
    expected_names = set(browser) | set(metadata)
    git_present = (source_root / ".git").exists()
    expected_dirs = _expected_directories(expected_names)
    if git_present:
        git_info = (source_root / ".git").lstat()
        if not stat.S_ISDIR(git_info.st_mode) or stat.S_ISLNK(git_info.st_mode) or _is_reparse(git_info):
            raise ValueError(".git must be a real, non-linked root directory")
    if actual_files != expected_names or actual_dirs != expected_dirs:
        raise ValueError(
            "inventory mismatch: "
            f"missing files={sorted(expected_names - actual_files)}; "
            f"extra files={sorted(actual_files - expected_names)}; "
            f"directories={sorted(actual_dirs)}"
        )
    for expected, label in ((browser, "browser"), (metadata, "repository metadata")):
        for name, digest in sorted(expected.items()):
            actual = _read_hash(source_root.joinpath(*name.split("/")))
            if actual != digest:
                raise ValueError(f"hash mismatch for {label} file {name}")
    return source_root, browser


def stage_repository_upload(
    checkout: Path,
    destination: Path,
    expected_files: dict[str, str],
    expected_metadata: dict[str, str],
) -> dict[str, str]:
    """Validate a clean site checkout, then copy browser files only."""
    source_root, browser = _validate_repository_checkout(checkout, expected_files, expected_metadata)
    target, _ = _fresh_destination(destination, source_root)
    return _copy_to_new_destination(source_root, target, browser)


def validate_release_checkout(
    checkout: Path,
    destination: Path,
    expected_files: dict[str, str],
    expected_metadata: dict[str, str],
    evidence: dict,
    approval: dict,
    expected_site_commit: str,
    observed_site_commit: str,
    *,
    validate_only: bool = False,
) -> dict[str, str]:
    """Validate the exact approved checkout and optionally stage only its browser files."""
    manifest_bytes = (Path(checkout) / "release-manifest.json").read_bytes()
    require_release(evidence, approval, observed_site_commit,
                    expected_metadata.get("release-manifest.json", ""), manifest_bytes)
    if expected_site_commit != observed_site_commit:
        raise ValueError("checkout differs from the approved site commit")
    source, browser = _validate_repository_checkout(checkout, expected_files, expected_metadata)
    approved_tree = evidence["site_tree_sha256"]
    if site_tree_sha256(browser) != approved_tree:
        raise ValueError("actual checkout browser tree does not match trusted release tree hash")
    if validate_only:
        actual = validate_site(destination, browser)
    else:
        actual = stage_repository_upload(source, destination, browser, expected_metadata)
    if site_tree_sha256(actual) != approved_tree:
        raise ValueError("validated upload tree does not match trusted release tree hash")
    return actual


def _strict_json(raw: bytes, label: str):
    def pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"{label} contains duplicate JSON key: {key}")
            result[key] = value
        return result

    def reject_constant(value):
        raise ValueError(f"{label} contains nonstandard JSON constant: {value}")

    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Malformed {label} JSON") from error


def _exact_fields(value, fields: set[str], label: str) -> None:
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError(f"{label} has missing or unknown fields")


def _commit(value, label: str) -> None:
    if not isinstance(value, str) or not _HEX_40.fullmatch(value):
        raise ValueError(f"{label} must be a full 40-character commit SHA")


def _digest(value, label: str) -> None:
    if not isinstance(value, str) or not _HEX_64.fullmatch(value):
        raise ValueError(f"{label} must be a lowercase SHA-256 digest")


def _public_manifest(raw: bytes, expected_digest: str) -> dict:
    _digest(expected_digest, "Expected manifest hash")
    if _sha256(raw) != expected_digest:
        raise ValueError("manifest hash does not match independent expected hash")
    manifest = _strict_json(raw, "manifest")
    _exact_fields(manifest, {"schema_version", "charter_commit", "build_revision", "built_at_utc", "files"}, "manifest")
    if type(manifest["schema_version"]) is not int or manifest["schema_version"] != 1:
        raise ValueError("manifest schema_version must be integer 1")
    _commit(manifest["charter_commit"], "manifest charter_commit")
    _commit(manifest["build_revision"], "manifest build_revision")
    stamp = manifest["built_at_utc"]
    if not isinstance(stamp, str) or not _UTC_TIMESTAMP.fullmatch(stamp):
        raise ValueError("manifest built_at_utc must be a UTC timestamp ending in Z")
    try:
        parsed_stamp = datetime.fromisoformat(stamp[:-1] + "+00:00")
    except ValueError as error:
        raise ValueError("manifest built_at_utc must be a UTC timestamp") from error
    if parsed_stamp.utcoffset() != timezone.utc.utcoffset(parsed_stamp):
        raise ValueError("manifest built_at_utc must be a UTC timestamp")
    hashes = _expectation_items(manifest["files"])
    if set(hashes) != BROWSER_FILES:
        raise ValueError("manifest file checksums must name exactly the public browser allowlist")
    return manifest


def require_release(
    evidence: dict,
    trusted_approval: dict | None,
    observed_site_commit: str,
    expected_manifest_sha256: str,
    manifest_bytes: bytes,
) -> dict:
    """Require exact, independently approved release identities and successful tests."""
    evidence_fields = {
        "schema_version", "charter_commit", "build_revision", "site_commit",
        "site_tree_sha256", "manifest_sha256", "tests",
    }
    approval_fields = evidence_fields | {
        "public_release_approved", "editorial_gate_current", "security_gates_resolved",
    }
    _exact_fields(evidence, evidence_fields, "release evidence")
    if trusted_approval is None:
        raise ValueError("trusted approval is required")
    _exact_fields(trusted_approval, approval_fields, "trusted approval")
    if type(evidence["schema_version"]) is not int or evidence["schema_version"] != 1:
        raise ValueError("release evidence schema_version must be integer 1")
    if type(trusted_approval["schema_version"]) is not int or trusted_approval["schema_version"] != 1:
        raise ValueError("trusted approval schema_version must be integer 1")
    for key in ("charter_commit", "build_revision", "site_commit"):
        _commit(evidence[key], f"release evidence {key}")
    _commit(observed_site_commit, "observed site commit")
    _digest(evidence["site_tree_sha256"], "release site tree hash")
    _digest(evidence["manifest_sha256"], "release manifest hash")
    for flag in ("public_release_approved", "editorial_gate_current", "security_gates_resolved"):
        if type(trusted_approval[flag]) is not bool or trusted_approval[flag] is not True:
            raise ValueError(f"trusted approval {flag} must be literal true")
    for key in ("charter_commit", "build_revision", "site_commit", "site_tree_sha256", "manifest_sha256"):
        if trusted_approval[key] != evidence[key]:
            raise ValueError(f"trusted approval does not match release {key}")
    if observed_site_commit != evidence["site_commit"]:
        raise ValueError("observed checkout does not match approved site commit")
    if expected_manifest_sha256 != evidence["manifest_sha256"]:
        raise ValueError("independent manifest hash does not match release evidence")

    tests = evidence["tests"]
    _exact_fields(tests, {"python", "node"}, "test attestations")
    for suite in ("python", "node"):
        attestation = tests[suite]
        _exact_fields(attestation, {"exit_code", "log_sha256"}, f"{suite} test attestation")
        if type(attestation["exit_code"]) is not int or attestation["exit_code"] != 0:
            raise ValueError(f"{suite} test suite did not pass")
        _digest(attestation["log_sha256"], f"{suite} test log hash")
    approval_tests = trusted_approval["tests"]
    _exact_fields(approval_tests, {"python", "node"}, "trusted test attestations")
    for suite in ("python", "node"):
        approved_attestation = approval_tests[suite]
        _exact_fields(approved_attestation, {"exit_code", "log_sha256"}, f"trusted {suite} test attestation")
        if type(approved_attestation["exit_code"]) is not int or approved_attestation["exit_code"] != 0:
            raise ValueError(f"trusted {suite} test attestation did not pass")
        _digest(approved_attestation["log_sha256"], f"trusted {suite} test log hash")
    if trusted_approval["tests"] != tests:
        raise ValueError("test suite evidence or log digests do not match trusted approval")

    manifest = _public_manifest(manifest_bytes, expected_manifest_sha256)
    if manifest["charter_commit"] != evidence["charter_commit"]:
        raise ValueError("manifest source commit does not match release evidence")
    if manifest["build_revision"] != evidence["build_revision"]:
        raise ValueError("manifest build revision does not match release evidence")
    if site_tree_sha256(manifest["files"]) != evidence["site_tree_sha256"]:
        raise ValueError("manifest file checksums do not match approved site tree")
    return evidence


def _load_environment_json(name: str) -> dict:
    raw = os.environ.get(name, "")
    if not raw:
        raise ValueError(f"{name} must come from the external trusted configuration")
    value = _strict_json(raw.encode("utf-8"), name)
    if not isinstance(value, dict):
        raise ValueError(f"{name} must contain a JSON object")
    return value


def _main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", type=Path, default=Path.cwd())
    parser.add_argument("--destination", type=Path, default=Path("upload-site"))
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--check-candidate", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.check_candidate:
            check_candidate(args.checkout)
            return 0
        expected_files = _load_environment_json("EXPECTED_BROWSER_HASHES_JSON")
        expected_metadata = _load_environment_json("EXPECTED_METADATA_HASHES_JSON")
        evidence = _load_environment_json("TRUSTED_EVIDENCE_JSON")
        approval = _load_environment_json("TRUSTED_APPROVAL_JSON")
        site_commit = os.environ.get("TRUSTED_SITE_COMMIT", "")
        observed_commit = os.environ.get("OBSERVED_SITE_COMMIT", "")
        if not site_commit or not observed_commit:
            raise ValueError("TRUSTED_SITE_COMMIT and OBSERVED_SITE_COMMIT must be externally supplied")
        expected_manifest_hash = expected_metadata.get("release-manifest.json", "")
        if site_commit != observed_commit:
            raise ValueError("checked-out site commit does not match external trusted site commit")
        validate_release_checkout(
            args.checkout, args.destination, expected_files, expected_metadata,
            evidence, approval, site_commit, observed_commit,
            validate_only=args.validate_only,
        )
        return 0
    except (OSError, ValueError) as error:
        print(f"RELEASE VALIDATION FAILED: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(_main())
