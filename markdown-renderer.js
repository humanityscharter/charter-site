const INLINE_TOKEN = '\uE000';
const BLOCK_TOKEN = '\uE001';
const CITATION_TOKEN = '\uE002';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

export function safeHref(value) {
  if (typeof value !== 'string' || value === '') return null;
  if (/^[\u0000-\u0020\u007f"'\\]/u.test(value) || /[\u0000-\u0020\u007f"'\\]/u.test(value)) return null;
  if (/^#[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)) return value;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function replaceMarkdownLinks(text, stash) {
  let output = '';
  let cursor = 0;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const open = text.indexOf('[', searchFrom);
    if (open < 0) break;
    const labelEnd = text.indexOf('](', open + 1);
    const nextOpen = text.indexOf('[', open + 1);
    if (labelEnd < 0 || (nextOpen >= 0 && nextOpen < labelEnd) || labelEnd === open + 1) {
      searchFrom = open + 1;
      continue;
    }
    let depth = 1;
    let targetEnd = -1;
    for (let index = labelEnd + 2; index < text.length; index += 1) {
      if (text[index] === '(') depth += 1;
      if (text[index] === ')') {
        depth -= 1;
        if (depth === 0) {
          targetEnd = index;
          break;
        }
      }
    }
    if (targetEnd < 0) {
      searchFrom = labelEnd + 2;
      continue;
    }

    const label = text.slice(open + 1, labelEnd);
    const target = text.slice(labelEnd + 2, targetEnd);
    const href = safeHref(target);
    output += text.slice(cursor, open);
    if (!href) {
      output += escapeHtml(label);
    } else {
      const external = href.startsWith('#') ? '' : ' target="_blank" rel="noopener noreferrer"';
      output += stash(`<a href="${escapeHtml(href)}"${external}>${escapeHtml(label)}</a>`);
    }
    cursor = targetEnd + 1;
    searchFrom = cursor;
  }
  return output + text.slice(cursor);
}

function replaceBareUrls(text, stash) {
  return text.replace(/https?:\/\/[^\s<"\uE000-\uE002]+/gu, url => {
    let cleanEnd = url.length;
    while (cleanEnd > 0 && /[.,;:]+/u.test(url[cleanEnd - 1])) cleanEnd -= 1;
    let clean = url.slice(0, cleanEnd);
    let trailing = url.slice(cleanEnd);
    while (clean.endsWith(')')) {
      const opens = (clean.match(/\(/gu) ?? []).length;
      const closes = (clean.match(/\)/gu) ?? []).length;
      if (closes <= opens) break;
      clean = clean.slice(0, -1);
      trailing = `)${trailing}`;
    }
    const href = safeHref(clean);
    return href
      ? `${stash(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(clean)}</a>`)}${trailing}`
      : url;
  });
}

function renderInlineWithCitations(value, citationState = null) {
  if (!value) return '';
  const tokens = [];
  const stash = html => {
    const index = tokens.push(html) - 1;
    return `${INLINE_TOKEN}${index}${INLINE_TOKEN}`;
  };
  let text = String(value).replaceAll(INLINE_TOKEN, '');

  text = text.replace(/`([^`]+)`/gu, (_, code) => stash(
    `<code style="background:var(--bg-surface-alt);padding:2px 5px;border-radius:4px;font-size:0.9em">${escapeHtml(code)}</code>`
  ));
  text = replaceMarkdownLinks(text, stash);
  text = replaceBareUrls(text, stash);
  if (citationState) {
    text = text.replace(/\uE002(\d+)\uE002/gu, (_, index) => {
      const occurrence = citationState.occurrences[Number(index)];
      if (!occurrence) return '';
      return stash(`<sup class="citation-ref"><a id="${occurrence.id}" href="#citation-source-${occurrence.number}" data-hc-action="citation-source" data-citation-target="citation-source-${occurrence.number}" aria-label="Source ${occurrence.number}">${occurrence.number}</a></sup>`);
    });
  }

  text = escapeHtml(text);
  text = text.replace(/\*\*(.+?)\*\*/gu, '<strong>$1</strong>');
  text = text.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/gu, '<em>$1</em>');
  return text.replace(new RegExp(`${INLINE_TOKEN}(\\d+)${INLINE_TOKEN}`, 'gu'), (_, index) => tokens[Number(index)] ?? '');
}

export function renderInline(value) {
  return renderInlineWithCitations(value);
}

export function renderMarkdown(value) {
  if (!value) return '';
  let markdown = String(value).replace(/\r\n/gu, '\n').replaceAll(BLOCK_TOKEN, '').replaceAll(CITATION_TOKEN, '');
  const blocks = [];
  const stash = html => {
    const index = blocks.push(html) - 1;
    return `\n\n${BLOCK_TOKEN}${index}${BLOCK_TOKEN}\n\n`;
  };

  markdown = markdown.replace(/```([\s\S]*?)```/gu, (_, code) => stash(
    `<pre style="background:var(--bg-surface-alt);padding:14px;border-radius:6px;overflow-x:auto;margin:16px 0;font-size:0.85rem"><code>${escapeHtml(code)}</code></pre>`
  ));

  const definitions = [];
  const bodyLines = [];
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const definition = lines[index].match(/^\[\^([^\]\r\n]+)\]:[ \t]*(.*)$/u);
    if (!definition) {
      bodyLines.push(lines[index]);
      continue;
    }
    const content = [definition[2]];
    while (index + 1 < lines.length && /^(?: {2,}|\t)\S/u.test(lines[index + 1])) {
      content.push(lines[index + 1].replace(/^(?: {2,}|\t)/u, ''));
      index += 1;
    }
    definitions.push({ id: definition[1], content });
  }
  markdown = bodyLines.join('\n');

  const noteById = new Map();
  definitions.forEach((definition, index) => {
    if (!noteById.has(definition.id)) noteById.set(definition.id, index);
  });
  const numberByNote = new Map();
  const referenceText = markdown.replace(/`[^`]+`/gu, '');
  for (const match of referenceText.matchAll(/\[\^([^\]]+)\]/gu)) {
    const noteIndex = noteById.get(match[1]);
    if (noteIndex !== undefined && !numberByNote.has(noteIndex)) {
      numberByNote.set(noteIndex, numberByNote.size + 1);
    }
  }
  for (let index = 0; index < definitions.length; index += 1) {
    if (!numberByNote.has(index)) numberByNote.set(index, numberByNote.size + 1);
  }
  const citationState = {
    numberByNote,
    occurrences: [],
    returnIdsByNote: new Map(definitions.map((_, index) => [index, []]))
  };
  const occurrencesByNote = new Map(definitions.map((_, index) => [index, 0]));
  markdown = markdown.split(/(`[^`]+`)/gu).map(fragment => {
    if (fragment.startsWith('`') && fragment.endsWith('`')) return fragment;
    return fragment.replace(/\[\^([^\]]+)\]/gu, (marker, id) => {
      const noteIndex = noteById.get(id);
      if (noteIndex === undefined) return marker;
      const occurrence = occurrencesByNote.get(noteIndex) + 1;
      occurrencesByNote.set(noteIndex, occurrence);
      const number = numberByNote.get(noteIndex);
      const occurrenceId = `citation-return-${number}-${occurrence}`;
      citationState.occurrences.push({ id: occurrenceId, noteIndex, number });
      citationState.returnIdsByNote.get(noteIndex).push(occurrenceId);
      return `${CITATION_TOKEN}${citationState.occurrences.length - 1}${CITATION_TOKEN}`;
    });
  }).join('');
  const inline = value => renderInlineWithCitations(value, citationState);
  markdown = markdown.replace(/((?:\|[^\n]+\|\n?)+)/gu, table => {
    const rows = table.trim().split('\n');
    if (rows.length < 2) return table;
    let output = '<div style="overflow-x:auto;margin:18px 0;"><table>';
    rows.forEach((row, index) => {
      if (row.includes('---')) return;
      const cells = row.split('|').map(cell => cell.trim()).filter((cell, cellIndex, all) => cellIndex > 0 && cellIndex < all.length - 1);
      if (!cells.length) return;
      const tag = index === 0 ? 'th' : 'td';
      output += `<tr>${cells.map(cell => `<${tag}>${inline(cell)}</${tag}>`).join('')}</tr>`;
    });
    return stash(`${output}</table></div>`);
  });
  markdown = markdown.replace(/((?:^[ \t]*>[^\n]*\n?)+)/gmu, block => {
    const content = block.split('\n').map(line => line.replace(/^[ \t]*>[ \t]?/u, '')).join('\n');
    const inner = content.split(/\n{2,}/u).map(part => part.trim()).filter(Boolean).map(part => {
      const heading = part.match(/^(#{1,4})\s+(.*)$/u);
      if (!heading) return `<p>${inline(part)}</p>`;
      const level = Math.min(4, Math.max(2, heading[1].length));
      return `<h${level}>${inline(heading[2])}</h${level}>`;
    }).join('');
    return stash(`<blockquote>${inner}</blockquote>`);
  });
  markdown = markdown.replace(/^# (.*$)/gmu, (_, text) => stash(`<h1 style="margin:24px 0 12px;font-size:1.8rem">${inline(text)}</h1>`));
  markdown = markdown.replace(/^## (.*$)/gmu, (_, text) => stash(`<h2 style="margin:20px 0 10px;font-size:1.4rem">${inline(text)}</h2>`));
  markdown = markdown.replace(/^### (.*$)/gmu, (_, text) => stash(`<h3 style="margin:16px 0 8px;font-size:1.15rem">${inline(text)}</h3>`));
  markdown = markdown.replace(/^#### (.*$)/gmu, (_, text) => stash(`<h4 style="margin:14px 0 6px;font-size:1.05rem">${inline(text)}</h4>`));
  markdown = markdown.replace(/^---$/gmu, () => stash('<hr style="border:none;border-top:1px solid var(--border-subtle);margin:24px 0;">'));

  const output = [];
  for (let part of markdown.split(/\n{2,}/u)) {
    part = part.trim();
    if (!part) continue;
    if (part.startsWith(BLOCK_TOKEN)) {
      output.push(part);
      continue;
    }
    const lines = part.split('\n');
    if (!lines.some(line => /^\s*(?:[-*]|\d+\.)\s+/u.test(line))) {
      output.push(`<p>${inline(part)}</p>`);
      continue;
    }
    let list = '';
    let current = null;
    for (const line of lines) {
      const unordered = line.match(/^(\s*)[-*]\s+(.*)$/u);
      const ordered = line.match(/^(\s*)(\d+)\.\s+(.*)$/u);
      if (unordered) {
        if (current !== 'ul') {
          if (current === 'ol') list += '</ol>\n';
          list += '<ul>\n';
          current = 'ul';
        }
        const style = unordered[1].length >= 2 ? ' style="margin-left:20px;list-style-type:circle"' : '';
        list += `  <li${style}>${inline(unordered[2])}</li>\n`;
      } else if (ordered) {
        if (current !== 'ol') {
          if (current === 'ul') list += '</ul>\n';
          list += `<ol${ordered[2] === '1' ? '' : ` start="${ordered[2]}"`}>\n`;
          current = 'ol';
        }
        list += `  <li>${inline(ordered[3])}</li>\n`;
      } else if (line.trim()) {
        list += `  <p style="margin:4px 0 8px">${inline(line)}</p>\n`;
      }
    }
    if (current) list += `</${current}>`;
    output.push(list);
  }

  const body = output.join('\n\n').replace(new RegExp(`${BLOCK_TOKEN}(\\d+)${BLOCK_TOKEN}`, 'gu'), (_, index) => blocks[Number(index)] ?? '');
  if (!definitions.length) return body;
  const sources = definitions.map((definition, index) => ({ definition, index }))
    .sort((left, right) => numberByNote.get(left.index) - numberByNote.get(right.index))
    .map(({ definition, index }) => {
    const number = numberByNote.get(index);
    const sourceText = definition.content.map(part => renderInline(part)).join('<br>');
    const returnLinks = citationState.returnIdsByNote.get(index).map((id, occurrenceIndex) =>
      `<a href="#${id}" data-hc-action="citation-return" data-citation-target="${id}" aria-label="Return to citation ${number}, occurrence ${occurrenceIndex + 1}">↩</a>`
    ).join(' ');
    return `<li id="citation-source-${number}" class="citation-source" tabindex="-1"><span class="citation-source-text">${sourceText}</span>${returnLinks ? ` <span class="citation-source-returns">${returnLinks}</span>` : ''}</li>`;
  }).join('');
  return `${body}\n\n<section class="citation-bibliography" aria-labelledby="citation-sources-heading"><h2 id="citation-sources-heading">Sources</h2><ol class="citation-sources">${sources}</ol></section>`;
}
