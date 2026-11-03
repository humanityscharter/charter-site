import { reactionPercent } from './reaction-client.js';
import { escapeHtml } from './markdown-renderer.js';

const CHOICES = [
  ['agree', 'Agree'],
  ['disagree', 'Disagree'],
  ['propose_change', 'Propose a Change']
];

export function renderReactionControls(chapter, snapshot, compact = false) {
  const chapterNumber = Number.isInteger(Number(chapter)) ? Number(chapter) : 0;
  const ready = snapshot?.status === 'ready';
  const busy = !ready || snapshot.pending;
  const total = ready ? snapshot.total : null;
  const status = !ready
    ? snapshot?.status === 'unavailable' ? 'Reactions unavailable' : 'Loading reactions…'
    : `${total} ${total === 1 ? 'reaction' : 'reactions'}`;
  const buttons = CHOICES.map(([value, label]) => {
    const count = ready ? snapshot.counts[value] : null;
    const percent = ready ? reactionPercent(count, total) : null;
    const share = ready
      ? `<span class="reaction-share">${count}${percent === null ? '' : ` · ${percent.toFixed(1)}%`}</span>`
      : '';
    return `<button type="button" class="reaction-choice" data-hc-action="react" data-chapter="${chapterNumber}" data-reaction="${value}" aria-pressed="${ready && snapshot.selected === value}"${busy ? ' disabled' : ''}><span>${label}</span>${share}</button>`;
  }).join('');
  const error = ready && snapshot.error
    ? `<p class="reaction-error" role="alert">${snapshot.error === 'rate-limited'
      ? 'Reaction not saved. Wait a moment and try again.'
      : 'We could not confirm your reaction. Please try again.'}</p>` : '';
  return `<section class="reaction-controls${compact ? ' compact' : ''}" data-chapter="${chapterNumber}" data-compact="${compact}" aria-label="Chapter ${chapterNumber} reader reactions"><div class="reaction-heading"><span>Reader reactions, not formal votes</span><span class="reaction-total" aria-live="polite">${status}</span></div><div class="reaction-choices">${buttons}</div>${error}</section>`;
}

export function renderChapterCard(chapter, snapshot) {
  const number = chapter.num;
  const readTime = Number.isFinite(chapter.read_time) ? chapter.read_time : 0;
  const words = Number.isFinite(chapter.word_count) ? chapter.word_count : 0;
  return `<article class="chapter-row"><div class="chapter-info"><h4>Chapter ${number}: ${escapeHtml(chapter.title)}</h4><p class="chapter-subtitle">${escapeHtml(chapter.subtitle)}</p><div class="meta">${readTime} min read • ${words.toLocaleString()} words</div></div><button class="chapter-open" type="button" data-hc-action="open-chapter" data-chapter="${number}">Open chapter</button>${renderReactionControls(number, snapshot, true)}</article>`;
}
