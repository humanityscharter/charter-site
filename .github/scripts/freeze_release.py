"""Freeze trusted site release values for one platform workflow attempt."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import sys
from pathlib import Path

import verify_release as verifier


MAX_RECORD_BYTES = 32768
CONFIGURATION_FIELDS = {
    "site_commit", "verifier_sha256", "freezer_sha256", "browser_hashes",
    "metadata_hashes", "evidence", "approval",
}
CONTEXT_FIELDS = {
    "repository", "ref", "event_name", "run_id", "run_attempt", "workflow_commit",
}
_POSITIVE_DECIMAL = re.compile(r"[1-9][0-9]*\Z")


def canonical_bytes(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("utf-8")


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _validate_configuration_shape(configuration: dict) -> dict:
    verifier._exact_fields(configuration, CONFIGURATION_FIELDS, "release configuration")
    for key in ("site_commit", "verifier_sha256", "freezer_sha256"):
        if not isinstance(configuration[key], str):
            raise ValueError(f"release configuration {key} must be a string")
    for key in ("browser_hashes", "metadata_hashes", "evidence", "approval"):
        if not isinstance(configuration[key], dict):
            raise ValueError(f"release configuration {key} must be a JSON object")
    return configuration


def _validate_context(context: dict, configuration: dict | None = None) -> dict:
    verifier._exact_fields(context, CONTEXT_FIELDS, "workflow context")
    if any(not isinstance(value, str) for value in context.values()):
        raise ValueError("workflow context fields must be strings")
    if configuration is not None:
        _validate_configuration_shape(configuration)
    if context["repository"] != "humanityscharter/charter-site":
        raise ValueError("workflow repository is not the approved site repository")
    if context["ref"] != "refs/heads/main":
        raise ValueError("workflow ref must be refs/heads/main")
    if context["event_name"] != "workflow_dispatch":
        raise ValueError("workflow event must be workflow_dispatch")
    for key in ("run_id", "run_attempt"):
        if not _POSITIVE_DECIMAL.fullmatch(context[key]):
            raise ValueError(f"workflow {key} must be a positive decimal string")
    verifier._commit(context["workflow_commit"], "workflow commit")
    if configuration is not None:
        if configuration["site_commit"] != context["workflow_commit"]:
            raise ValueError("approved site commit must match the workflow commit")
    return context


def _validate_configuration(configuration: dict, observed_site_commit: str,
                             manifest_bytes: bytes | None = None) -> dict:
    _validate_configuration_shape(configuration)
    verifier._commit(configuration["site_commit"], "approved site commit")
    verifier._commit(observed_site_commit, "observed site commit")
    if configuration["site_commit"] != observed_site_commit:
        raise ValueError("approved site commit does not match observed checkout commit")
    browser = verifier._expectation_items(configuration["browser_hashes"])
    metadata = verifier._expectation_items(configuration["metadata_hashes"])
    if set(browser) != verifier.BROWSER_FILES:
        raise ValueError("browser hashes must name the exact reviewed 19-file allowlist")
    if set(metadata) != verifier.REPOSITORY_METADATA:
        raise ValueError("metadata hashes must name the exact reviewed five-file allowlist")
    verifier._digest(configuration["verifier_sha256"], "approved verifier hash")
    verifier._digest(configuration["freezer_sha256"], "approved freezer hash")
    if configuration["verifier_sha256"] != metadata[".github/scripts/verify_release.py"]:
        raise ValueError("approved verifier hash differs from independent metadata")
    if configuration["freezer_sha256"] != metadata[".github/scripts/freeze_release.py"]:
        raise ValueError("approved freezer hash differs from independent metadata")
    if not isinstance(configuration["evidence"], dict) or not isinstance(configuration["approval"], dict):
        raise ValueError("release evidence and approval must be JSON objects")
    evidence = configuration["evidence"]
    if evidence.get("site_commit") != configuration["site_commit"]:
        raise ValueError("release evidence does not match approved site commit")
    if evidence.get("manifest_sha256") != metadata["release-manifest.json"]:
        raise ValueError("approved manifest hash differs from independent metadata")
    if evidence.get("site_tree_sha256") != verifier.site_tree_sha256(browser):
        raise ValueError("approved browser hashes differ from release evidence")
    if manifest_bytes is not None:
        verifier.require_release(evidence, configuration["approval"], observed_site_commit,
                                 metadata["release-manifest.json"], manifest_bytes)
        manifest = verifier._public_manifest(manifest_bytes, metadata["release-manifest.json"])
        if browser != manifest["files"]:
            raise ValueError("browser hashes differ from approved public manifest")
    return {"browser_hashes": browser, "metadata_hashes": metadata}


def freeze_release(configuration: dict, context: dict, manifest_bytes: bytes,
                   observed_site_commit: str) -> bytes:
    """Return a canonical run-bound record after validating release evidence and manifest."""
    config_copy = copy.deepcopy(configuration)
    context_copy = copy.deepcopy(context)
    _validate_configuration_shape(config_copy)
    _validate_context(context_copy, config_copy)
    _validate_configuration(config_copy, observed_site_commit, manifest_bytes)
    payload = canonical_bytes({"schema_version": 1, "context": context_copy,
                               "configuration": config_copy})
    if len(payload) > MAX_RECORD_BYTES:
        raise ValueError("frozen release record exceeds 32768 bytes")
    return payload


def thaw_release(payload: bytes, expected_digest: str, context: dict) -> dict:
    """Validate canonical record bytes, digest, configuration shape and run binding."""
    if not isinstance(payload, bytes) or len(payload) > MAX_RECORD_BYTES:
        raise ValueError("frozen release record must be bytes no larger than 32768 bytes")
    verifier._digest(expected_digest, "frozen release digest")
    if digest_bytes(payload) != expected_digest:
        raise ValueError("frozen release digest does not match payload")
    envelope = verifier._strict_json(payload, "frozen release record")
    verifier._exact_fields(envelope, {"schema_version", "context", "configuration"},
                           "frozen release record")
    if type(envelope["schema_version"]) is not int or envelope["schema_version"] != 1:
        raise ValueError("frozen release schema_version must be integer 1")
    if canonical_bytes(envelope) != payload:
        raise ValueError("frozen release record is not canonically encoded")
    _validate_configuration_shape(envelope["configuration"])
    expected_context = copy.deepcopy(context)
    _validate_context(expected_context)
    record_context = _validate_context(envelope["context"], envelope["configuration"])
    if record_context != expected_context:
        raise ValueError("frozen release record belongs to a different workflow run")
    _validate_configuration(envelope["configuration"], record_context["workflow_commit"])
    return copy.deepcopy(envelope["configuration"])


def _strict_environment_json(name: str) -> dict:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        raise ValueError(f"{name} is required from trusted configuration")
    value = verifier._strict_json(raw.encode("utf-8"), name)
    if not isinstance(value, dict):
        raise ValueError(f"{name} must contain a JSON object")
    return value


def _required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"{name} is required")
    return value


def _context_from_environment() -> dict:
    names = {
        "repository": "HC_RELEASE_REPOSITORY",
        "ref": "HC_RELEASE_REF",
        "event_name": "HC_RELEASE_EVENT",
        "run_id": "HC_RELEASE_RUN_ID",
        "run_attempt": "HC_RELEASE_RUN_ATTEMPT",
        "workflow_commit": "HC_RELEASE_WORKFLOW_COMMIT",
    }
    return {field: _required_environment(environment) for field, environment in names.items()}


def _configuration_from_environment() -> dict:
    return {
        "site_commit": _required_environment("TRUSTED_SITE_COMMIT"),
        "verifier_sha256": _required_environment("TRUSTED_VERIFIER_SHA256"),
        "freezer_sha256": _required_environment("TRUSTED_FREEZER_SHA256"),
        "browser_hashes": _strict_environment_json("EXPECTED_BROWSER_HASHES_JSON"),
        "metadata_hashes": _strict_environment_json("EXPECTED_METADATA_HASHES_JSON"),
        "evidence": _strict_environment_json("TRUSTED_EVIDENCE_JSON"),
        "approval": _strict_environment_json("TRUSTED_APPROVAL_JSON"),
    }


def _write_outputs(path: Path, values: dict[str, str]) -> None:
    output = Path(path)
    if not output.is_file():
        raise ValueError("GITHUB_OUTPUT must name an existing operation-owned output file")
    with output.open("a", encoding="utf-8", newline="\n") as stream:
        for name, value in values.items():
            if "\n" in value or "\r" in value:
                raise ValueError(f"GitHub output {name} must fit on one line")
            stream.write(f"{name}={value}\n")


def _main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--freeze", action="store_true")
    mode.add_argument("--validate-frozen", action="store_true")
    parser.add_argument("--checkout", type=Path, required=True)
    parser.add_argument("--destination", type=Path, default=Path("upload-site"))
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args(argv)
    try:
        context = _context_from_environment()
        observed = _required_environment("OBSERVED_SITE_COMMIT")
        if args.freeze:
            configuration = _configuration_from_environment()
            manifest = (args.checkout / "release-manifest.json").read_bytes()
            payload = freeze_release(configuration, context, manifest, observed)
            hashes = _validate_configuration(configuration, observed, manifest)
            source, browser = verifier._validate_repository_checkout(
                args.checkout, hashes["browser_hashes"], hashes["metadata_hashes"])
            if verifier.site_tree_sha256(browser) != configuration["evidence"]["site_tree_sha256"]:
                raise ValueError("actual checkout browser tree does not match trusted release tree hash")
            output_path = _required_environment("GITHUB_OUTPUT")
            _write_outputs(Path(output_path), {
                "frozen_release_json": payload.decode("utf-8"),
                "frozen_release_sha256": digest_bytes(payload),
                "approved_site_commit": configuration["site_commit"],
                "approved_verifier_sha256": configuration["verifier_sha256"],
                "approved_freezer_sha256": configuration["freezer_sha256"],
            })
            print(f"Release frozen for {configuration['site_commit']} with record digest "
                  f"{digest_bytes(payload)}; deployment approval is still required.")
            return 0

        payload = _required_environment("FROZEN_RELEASE_JSON").encode("utf-8")
        digest = _required_environment("FROZEN_RELEASE_SHA256")
        configuration = thaw_release(payload, digest, context)
        validate_only = args.validate_only
        verifier.validate_release_checkout(
            args.checkout, args.destination, configuration["browser_hashes"],
            configuration["metadata_hashes"], configuration["evidence"],
            configuration["approval"], configuration["site_commit"], observed,
            validate_only=validate_only,
        )
        return 0
    except (OSError, ValueError) as error:
        print(f"RELEASE FREEZE VALIDATION FAILED: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(_main())
