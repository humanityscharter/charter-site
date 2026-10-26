import { apiUrl } from './api-config.js';

const CHOICES = ['agree', 'disagree', 'propose_change'];

export function reactionPercent(count, total) {
  return total === 0 ? null : Math.round((count / total) * 1000) / 10;
}

function validChapter(data, chapter) {
  if (!data || data.chapter !== chapter || !data.counts ||
    !Number.isInteger(data.total) || data.total < 0 ||
    !(data.selected === null || CHOICES.includes(data.selected))) return false;
  const counts = CHOICES.map(choice => data.counts[choice]);
  return counts.every(count => Number.isInteger(count) && count >= 0) &&
    counts.reduce((sum, count) => sum + count, 0) === data.total;
}

function initialState() {
  return {
    status: 'loading', counts: null, total: null,
    selected: null, pending: false, error: null
  };
}

export class ReactionClient {
  constructor(fetchImpl = fetch, endpoint = apiUrl('/api/reactions')) {
    this.fetchImpl = fetchImpl;
    this.endpoint = endpoint;
    this.listeners = new Set();
    this.chapters = Array.from({ length: 26 }, initialState);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(chapter = null) {
    for (const listener of this.listeners) listener(chapter);
  }

  get(chapter) {
    if (!Number.isInteger(chapter) || chapter < 1 || chapter > 26) return null;
    return this.chapters[chapter - 1];
  }

  async load() {
    try {
      const response = await this.fetchImpl.call(globalThis, this.endpoint, {
        method: 'GET', credentials: 'include', cache: 'no-store'
      });
      if (!response.ok) throw new Error('GET failed');
      const data = await response.json();
      if (!Array.isArray(data.chapters) || data.chapters.length !== 26 ||
        data.chapters.some((chapter, index) => !validChapter(chapter, index + 1))) {
        throw new Error('Invalid reaction response');
      }
      this.chapters = data.chapters.map(chapter => ({
        status: 'ready', counts: chapter.counts, total: chapter.total,
        selected: chapter.selected, pending: false, error: null
      }));
    } catch {
      this.chapters = Array.from({ length: 26 }, () => ({
        ...initialState(), status: 'unavailable'
      }));
    }
    this.notify();
  }

  async choose(chapter, reaction) {
    const current = this.get(chapter);
    if (!current || current.status !== 'ready' || current.pending || !CHOICES.includes(reaction)) return;
    current.pending = true;
    current.error = null;
    this.notify(chapter);
    try {
      const response = await this.fetchImpl.call(globalThis, this.endpoint, {
        method: 'POST', credentials: 'include', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapter, reaction })
      });
      if (!response.ok) {
        current.error = response.status === 429 ? 'rate-limited' : 'not-saved';
        throw new Error('POST failed');
      }
      const data = await response.json();
      if (!validChapter(data, chapter)) throw new Error('Invalid reaction response');
      this.chapters[chapter - 1] = {
        status: 'ready', counts: data.counts, total: data.total,
        selected: data.selected, pending: false, error: null
      };
    } catch {
      current.pending = false;
      current.error ??= 'not-saved';
    }
    this.notify(chapter);
  }
}
