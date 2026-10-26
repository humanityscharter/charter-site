// Humanity's Charter, Interactive Client Application
import { ReactionClient } from './reaction-client.js';
import { renderChapterCard, renderReactionControls } from './reaction-view.js';
import { ProposalClient } from './proposal-client.js';
import { TURNSTILE_SITE_KEY } from './api-config.js';
import { escapeHtml, renderInline, renderMarkdown } from './markdown-renderer.js';

const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

function proposalFailureMessage(reason) {
  const messages = {
    challenge_failed: 'Verification was not accepted. Complete the verification again and resubmit.',
    validation: 'The proposal did not pass validation. Check the field requirements and try again.',
    rate_limited: 'This submission limit has been reached. Your form is still filled in; try again later.',
    network: 'Could not reach the proposal service. Your form is still filled in; check your connection and try again.',
    unavailable: 'The proposal service is temporarily unavailable. Your form is still filled in; try again later.',
    invalid_response: 'The proposal service returned an unexpected response. Your form is still filled in; try again.'
  };
  return messages[reason] ?? 'The proposal service could not confirm the result. Your form is still filled in; try again.';
}

function lookupFailureMessage(reason) {
  if (reason === 'validation') return 'Enter the complete receipt exactly as it was issued.';
  if (reason === 'rate_limited') return 'Too many status checks right now. Your receipt is still here; wait and try again.';
  if (reason === 'network') return 'Could not reach the status service. Check your connection and try again.';
  return 'Receipt status is temporarily unavailable. Try again later.';
}

function receiptDownloadText(receipt, receivedAt) {
  return [
    "Humanity's Charter proposal receipt",
    '',
    `Receipt: ${receipt}`,
    `Receipt displayed: ${receivedAt}`,
    '',
    'Check a receipt at https://humanityscharter.org/#propose.',
    'Keep this receipt private and somewhere safe.',
    'Warning: losing this receipt may prevent status lookup.'
  ].join('\n');
}

function safeDiscordUrl(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || !(hostname === 'discord.gg' || hostname === 'discord.com' || hostname.endsWith('.discord.com'))) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function isTurnstileSiteKeyConfigured(value) {
  return typeof value === 'string' && /^0x4[A-Za-z0-9_-]{10,}$/u.test(value);
}

/**
 * Bind the public proposal and receipt forms. Dependencies and elements are
 * explicit so the browser boundary can be tested without a DOM library.
 */
export function createProposalController(elements, dependencies = {}) {
  const {
    client = new ProposalClient(),
    turnstile: initialTurnstile = null,
    siteKey = TURNSTILE_SITE_KEY,
    navigatorRef = globalThis.navigator,
    urlRef = globalThis.URL,
    BlobCtor = globalThis.Blob,
    now = () => new Date()
  } = dependencies;

  let turnstile = null;
  let widgetId = null;
  let challengeToken = '';
  let receipt = '';
  let receivedAt = '';
  const configurationReady = isTurnstileSiteKeyConfigured(siteKey);

  function setStatus(message, tone = '') {
    elements.status.textContent = message;
    elements.status.className = `proposal-status${tone ? ` proposal-status-${tone}` : ''}`;
  }

  function setChallengeStatus(message, tone = '') {
    elements.challengeStatus.textContent = message;
    elements.challengeStatus.className = `proposal-status${tone ? ` proposal-status-${tone}` : ''}`;
  }

  function resetChallenge() {
    challengeToken = '';
    if (turnstile && widgetId !== null) turnstile.reset(widgetId);
  }

  function setTurnstile(api) {
    elements.proposalFields.disabled = true;
    if (!configurationReady) {
      setChallengeStatus('Proposal intake is not configured yet. Receipt lookup remains available.', 'error');
      return;
    }
    if (!api || typeof api.render !== 'function') {
      setChallengeStatus('Human verification could not be loaded. Proposal intake remains unavailable; refresh the page and try again.', 'error');
      return;
    }
    turnstile = api;
    try {
      widgetId = api.render(elements.turnstileContainer, {
        sitekey: siteKey,
        action: 'proposal_submit',
        size: 'compact',
        callback(token) {
          challengeToken = typeof token === 'string' ? token : '';
          if (challengeToken) setChallengeStatus('');
        },
        'expired-callback'() {
          resetChallenge();
          setChallengeStatus('Verification expired. Complete it again before submitting.', 'error');
        },
        'error-callback'() {
          resetChallenge();
          setChallengeStatus('Verification could not be completed. Try the challenge again.', 'error');
        }
      });
      if (typeof widgetId !== 'string' || widgetId === '') throw new Error('Turnstile widget unavailable');
      elements.proposalFields.disabled = false;
      setChallengeStatus('');
    } catch {
      widgetId = null;
      turnstile = null;
      setChallengeStatus('Human verification could not be loaded. Proposal intake remains unavailable; refresh the page and try again.', 'error');
    }
  }

  function proposalPayload() {
    const email = elements.email.value.trim();
    return {
      name: elements.name.value.trim(),
      ...(email ? { email } : {}),
      chapter: Number(elements.chapter.value),
      type: elements.type.value,
      proposedChange: elements.proposedChange.value.trim(),
      rationale: elements.rationale.value.trim(),
      contactRequested: elements.contactRequested.checked,
      consent: elements.consent.checked,
      website: elements.website.value
    };
  }

  function showReceipt(serverReceipt, serverMessage) {
    receipt = serverReceipt;
    receivedAt = now().toISOString();
    elements.receiptValue.textContent = receipt;
    elements.receiptDate.textContent = receivedAt;
    elements.receiptPanel.hidden = false;
    setStatus(serverMessage || 'Your proposal was received for review.', 'success');
  }

  async function submit(event) {
    event.preventDefault();
    if (!configurationReady || elements.proposalFields.disabled || widgetId === null) {
      const message = configurationReady
        ? 'Proposal intake is unavailable until human verification loads.'
        : 'Proposal intake is not configured yet. Receipt lookup remains available.';
      setChallengeStatus(message, 'error');
      return;
    }
    if (!challengeToken) {
      if (!elements.challengeStatus.textContent) {
        setChallengeStatus('Complete the human verification before submitting.', 'error');
      }
      return;
    }

    elements.submitButton.disabled = true;
    elements.submitButton.textContent = 'Submitting…';
    setStatus('Submitting for review…');
    try {
      const result = await client.submit(proposalPayload(), challengeToken);
      if (!result.ok) {
        setStatus(proposalFailureMessage(result.reason), 'error');
        resetChallenge();
        return;
      }
      showReceipt(result.receipt, result.message);
      elements.form.reset();
      resetChallenge();
    } catch {
      setStatus(proposalFailureMessage('network'), 'error');
      resetChallenge();
    } finally {
      elements.submitButton.disabled = false;
      elements.submitButton.textContent = 'Submit for Review';
    }
  }

  async function copyReceipt() {
    if (!receipt) return;
    if (!navigatorRef?.clipboard?.writeText) {
      setStatus('Copy is not available in this browser. Select and save the receipt above.', 'error');
      return;
    }
    try {
      await navigatorRef.clipboard.writeText(receipt);
      setStatus('Receipt copied. Save it somewhere safe.', 'success');
    } catch {
      setStatus('The receipt could not be copied. Select and save it manually.', 'error');
    }
  }

  function downloadReceipt() {
    if (!receipt || !BlobCtor || !urlRef?.createObjectURL) return;
    const blob = new BlobCtor([receiptDownloadText(receipt, receivedAt)], {
      type: 'text/plain;charset=utf-8'
    });
    const objectUrl = urlRef.createObjectURL(blob);
    const anchor = elements.documentRef.createElement('a');
    anchor.setAttribute('href', objectUrl);
    anchor.setAttribute('download', 'humanitys-charter-proposal-receipt.txt');
    elements.documentRef.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    urlRef.revokeObjectURL(objectUrl);
  }

  function appendLookupField(label, value) {
    if (value === null || value === undefined || value === '') return;
    const row = elements.documentRef.createElement('p');
    row.textContent = `${label}: ${String(value)}`;
    elements.lookupResult.appendChild(row);
  }

  function showLookupResult(result) {
    elements.lookupResult.replaceChildren();
    if (!result.found) {
      const message = elements.documentRef.createElement('p');
      message.textContent = 'No proposal was found for that receipt. Check the receipt and try again.';
      elements.lookupResult.appendChild(message);
      return;
    }

    appendLookupField('Status', result.status);
    appendLookupField('Received', result.receivedAt);
    appendLookupField('Last updated', result.updatedAt);
    appendLookupField('Public outcome', result.publicOutcome);
    const discordUrl = safeDiscordUrl(result.discordUrl);
    if (discordUrl) {
      const link = elements.documentRef.createElement('a');
      link.textContent = 'Open the public Discord discussion';
      link.setAttribute('href', discordUrl);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      elements.lookupResult.appendChild(link);
    }
  }

  async function lookup(event) {
    event.preventDefault();
    elements.lookupButton.disabled = true;
    elements.lookupButton.textContent = 'Checking…';
    elements.lookupResult.replaceChildren();
    try {
      const result = await client.lookup(elements.lookupInput.value.trim());
      if (!result.ok) {
        const message = elements.documentRef.createElement('p');
        message.textContent = lookupFailureMessage(result.reason);
        elements.lookupResult.appendChild(message);
        return;
      }
      showLookupResult(result);
    } catch {
      const message = elements.documentRef.createElement('p');
      message.textContent = lookupFailureMessage('network');
      elements.lookupResult.appendChild(message);
    } finally {
      elements.lookupButton.disabled = false;
      elements.lookupButton.textContent = 'Check status';
    }
  }

  elements.form.addEventListener('submit', submit);
  elements.copyButton.addEventListener('click', copyReceipt);
  elements.downloadButton.addEventListener('click', downloadReceipt);
  elements.lookupForm.addEventListener('submit', lookup);
  elements.lookupFields.disabled = false;
  if (!configurationReady) {
    setChallengeStatus('Proposal intake is not configured yet. Receipt lookup remains available.', 'error');
  } else if (initialTurnstile) {
    setTurnstile(initialTurnstile);
  } else {
    setChallengeStatus('Human verification is loading. Proposal submission will be available when it is ready.');
  }

  return { configurationReady, setTurnstile };
}

export function loadTurnstile(documentRef = document, windowRef = window) {
  if (windowRef.turnstile) return Promise.resolve(windowRef.turnstile);
  return new Promise((resolve, reject) => {
    let script = documentRef.getElementById('turnstile-script');
    if (!script) {
      script = documentRef.createElement('script');
      script.id = 'turnstile-script';
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      documentRef.head.appendChild(script);
    }
    script.addEventListener('load', () => {
      if (windowRef.turnstile) resolve(windowRef.turnstile);
      else reject(new Error('Turnstile did not initialize'));
    }, { once: true });
    script.addEventListener('error', () => reject(new Error('Turnstile failed to load')), { once: true });
  });
}

function proposalElements(documentRef) {
  return {
    documentRef,
    form: documentRef.getElementById('proposal-form-el'),
    proposalFields: documentRef.getElementById('proposal-fields'),
    submitButton: documentRef.getElementById('proposal-submit'),
    status: documentRef.getElementById('proposal-status'),
    challengeStatus: documentRef.getElementById('proposal-challenge-status'),
    name: documentRef.getElementById('prop-name'),
    email: documentRef.getElementById('prop-email'),
    chapter: documentRef.getElementById('proposal-chapter'),
    type: documentRef.getElementById('prop-type'),
    proposedChange: documentRef.getElementById('prop-summary'),
    rationale: documentRef.getElementById('prop-rationale'),
    contactRequested: documentRef.getElementById('prop-contact-requested'),
    consent: documentRef.getElementById('prop-consent'),
    website: documentRef.getElementById('proposal-website'),
    turnstileContainer: documentRef.getElementById('proposal-turnstile'),
    receiptPanel: documentRef.getElementById('proposal-receipt'),
    receiptValue: documentRef.getElementById('proposal-receipt-value'),
    receiptDate: documentRef.getElementById('proposal-receipt-date'),
    copyButton: documentRef.getElementById('proposal-copy-receipt'),
    downloadButton: documentRef.getElementById('proposal-download-receipt'),
    lookupForm: documentRef.getElementById('proposal-lookup-form'),
    lookupFields: documentRef.getElementById('proposal-lookup-fields'),
    lookupInput: documentRef.getElementById('proposal-lookup-receipt'),
    lookupButton: documentRef.getElementById('proposal-lookup-submit'),
    lookupResult: documentRef.getElementById('proposal-lookup-result')
  };
}

(function() {
  'use strict';

  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  const reactionClient = new ReactionClient();
  const proposalClient = new ProposalClient();

  // State
  const state = {
    currentChapter: null,
    currentAppendix: null,
    readerMode: 'exec', // 'exec' or 'full'
    readerOpener: null,
    searchQuery: '',
    theme: localStorage.getItem('hc_theme') || 'light'
  };

  const readerFocusableSelector = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function getReaderOverlay() {
    return document.getElementById('reader-overlay');
  }

  function readerDialog() {
    return getReaderOverlay()?.querySelector('.reader-container') ?? null;
  }

  function readerFocusableElements() {
    const dialog = readerDialog();
    if (!dialog) return [];
    return [...dialog.querySelectorAll(readerFocusableSelector)].filter(element => {
      if (element.closest?.('[hidden], [inert]')) return false;
      if (element.matches?.(':disabled')) return false;
      if (element.tabIndex < 0) return false;
      if (globalThis.getComputedStyle?.(element).visibility === 'hidden') return false;
      return typeof element.getClientRects !== 'function' || element.getClientRects().length > 0;
    });
  }

  function focusReader() {
    (readerFocusableElements()[0] ?? readerDialog())?.focus();
  }

  function focusReaderAndResetScroll() {
    focusReader();
    const readerContent = getReaderOverlay()?.querySelector('.reader-content');
    if (readerContent) readerContent.scrollTop = 0;
  }

  function openReader() {
    const overlay = getReaderOverlay();
    if (!overlay) return;
    if (!overlay.classList.contains('open')) {
      state.readerOpener = document.activeElement;
      overlay.classList.add('open');
      focusReader();
    }
    const readerContent = overlay.querySelector('.reader-content');
    if (readerContent) readerContent.scrollTop = 0;
    document.body.style.overflow = 'hidden';
  }

  // Set Theme
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('hc_theme', theme);
    const themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) {
      themeBtn.innerHTML = theme === 'dark' ? '☀' : '☾';
      themeBtn.title = theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode';
    }
  }

  // Eight Systems Data
  const systems = [
    { num: "System 1", title: "Economic Foundation", desc: "Universal Basic Resources (UBR) guaranteeing food, shelter, healthcare, and education as rights.", ch: 6 },
    { num: "System 2", title: "Housing & Urban Design", desc: "Dense, walkable, green communities with automated construction and communal hubs.", ch: 1 },
    { num: "System 3", title: "Education & Development", desc: "Self-directed learning and mentorship for human flourishing rather than labor compliance.", ch: 7 },
    { num: "System 4", title: "Healthcare & Vitality", desc: "Preventive, universal medicine and research aimed at treating aging as a manageable biological condition.", ch: 13 },
    { num: "System 5", title: "Governance & Decision-Making", desc: "Six-layer deliberative democracy, sortition citizen assemblies, and local subsidiarity.", ch: 5 },
    { num: "System 6", title: "Work and Purpose", desc: "Voluntary contribution, culture and heritage, mastery, and serious play.", ch: 3 },
    { num: "System 7", title: "Social Fabric and Community", desc: "Intentional community bonds, shared spaces, mutual support, and intergenerational connection.", ch: 2 },
    { num: "System 8", title: "Technology Infrastructure", desc: "AI and robotics as open public infrastructure, with privacy-protecting design and an aspirational zero-metadata goal.", ch: 4 }
  ];

  // Render 8 Systems
  function renderSystems() {
    const container = document.getElementById('systems-container');
    if (!container) return;
    container.innerHTML = systems.map(sys => `
      <div class="system-card" data-hc-action="open-system" data-system="${Number(sys.num.replace('System ', ''))}" role="button" tabindex="0">
        <div>
          <span class="num">${sys.num}</span>
          <h3>${sys.title}</h3>
          <p>${sys.desc}</p>
        </div>
        <div class="cta">Explore System &rarr;</div>
      </div>
    `).join('');
  }

  // Render Directory
  function renderDirectory(chapters) {
    const container = document.getElementById('directory-container');
    if (!container) return;

    if (!chapters || chapters.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:48px 24px;background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:var(--radius-md);margin:20px 0;">
          <h3 style="margin-bottom:8px;font-size:1.2rem">No matching chapters found</h3>
          <p style="color:var(--text-muted);font-size:0.95rem;max-width:480px;margin:0 auto">
            Try searching for other terms like <em>UBR</em>, <em>energy</em>, <em>sortition</em>, <em>aging</em>, <em>housing</em>, or <em>privacy</em>.
          </p>
        </div>
      `;
      return;
    }

    const parts = [
      { id: 1, title: "Part I: The Vision & Foundations (Chapters 1–3)" },
      { id: 2, title: "Part II: Foundational Systems & Institutions (Chapters 4–13)" },
      { id: 3, title: "Part III: Critical Challenges & Safeguards (Chapters 14–17)" },
      { id: 4, title: "Part IV: Global Dimensions & Planetary Stewardship (Chapters 18–21)" },
      { id: 5, title: "Part V: Action & Transformation Roadmap (Chapters 22–26)" }
    ];

    container.innerHTML = parts.map(part => {
      const partChapters = chapters.filter(c => c.part_id === part.id);
      if (partChapters.length === 0) return '';
      return `
        <div class="part-group">
          <h3 class="part-title">${part.title}</h3>
          <div class="chapters-grid">
            ${partChapters.map(ch => renderChapterCard(ch, reactionClient.get(ch.num))).join('')}
          </div>
        </div>
      `;
    }).join('');
  }

  // Render Appendices
  function renderAppendices(appendices) {
    const container = document.getElementById('appendices-container');
    if (!container) return;

    if (!appendices || appendices.length === 0) {
      container.innerHTML = `
        <div style="grid-column:1 / -1;text-align:center;padding:36px 20px;background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:var(--radius-md);">
          <p style="color:var(--text-muted);font-size:0.95rem;margin-bottom:0">No technical appendices match your search.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = appendices.map(app => `
      <div class="appendix-card" data-hc-action="open-appendix" data-slug="${escapeHtml(app.slug)}" role="button" tabindex="0">
        <div>
          <div class="badge">Reference • Appendix ${escapeHtml(app.letter)}</div>
          <h3>${escapeHtml(app.title)}</h3>
          <p>${escapeHtml(app.subtitle || '')}</p>
        </div>
        <div class="meta">
          <span>${app.read_time} min read • ${app.word_count.toLocaleString()} words</span>
          <span style="color:var(--brand-olive);font-weight:700">&rarr;</span>
        </div>
      </div>
    `).join('');
  }

  // Reader Open for Chapters
  function openChapter(num) {
    const data = window.CHARTER_DATA;
    if (!data || !data.chapters) return;
    const chapter = data.chapters.find(c => c.num === num);
    if (!chapter) return;

    openReader();
    state.currentChapter = chapter;
    state.currentAppendix = null;
    state.readerMode = 'exec'; // default to executive view

    document.getElementById('reader-modal-title').textContent = chapter.full_title;
    renderReaderBody();
    focusReaderAndResetScroll();

    // Update URL hash
    history.replaceState(null, '', `#chapter-${num}`);
  }

  function openSystem(num) {
    if (!Number.isInteger(num) || num < 1 || num > 8) return;
    const data = window.CHARTER_DATA;
    if (!data || typeof data.front_matter !== 'string') return;
    if (!Array.isArray(data.system_architecture) || !Array.isArray(data.chapters)) {
      openFrontMatter();
      return;
    }
    const architecture = data.system_architecture.find(item => item?.num === num);
    const system = systems.find(item => Number(item.num.replace('System ', '')) === num);
    const chapterNumbers = architecture?.chapter_numbers;
    if (!system || typeof architecture?.title !== 'string' || !architecture.title.trim()
      || typeof architecture.focus !== 'string' || !architecture.focus.trim()
      || !Array.isArray(chapterNumbers) || chapterNumbers.length === 0
      || chapterNumbers.some(chapter => !Number.isInteger(chapter) || chapter < 1 || chapter > 26)
      || new Set(chapterNumbers).size !== chapterNumbers.length) {
      openFrontMatter();
      return;
    }

    const relatedChapters = chapterNumbers.map(chapterNumber =>
      data.chapters.find(chapter => chapter.num === chapterNumber)
    );
    if (relatedChapters.some(chapter => !chapter)) {
      openFrontMatter();
      return;
    }

    openReader();
    state.currentChapter = null;
    state.currentAppendix = null;
    state.readerMode = 'exec';
    document.getElementById('reader-modal-title').textContent = `${system.num}: ${system.title}`;
    document.getElementById('reader-tabs-container').innerHTML = '';
    document.getElementById('reader-body-content').innerHTML = `
      <div class="md-view">
        <p>${escapeHtml(architecture.focus)}</p>
        <p>${escapeHtml(system.desc)}</p>
        <h3>Related Chapters</h3>
        <ul>
          ${relatedChapters.map(chapter => `
            <li>
              <h4>${escapeHtml(chapter.full_title)}</h4>
              <p>${escapeHtml(chapter.core_premise)}</p>
              <button class="btn btn-secondary btn-sm" data-hc-action="open-chapter" data-chapter="${chapter.num}">Open Chapter Summary</button>
            </li>
          `).join('')}
        </ul>
      </div>
      <div class="reader-close-row">
        <button class="btn btn-secondary btn-sm" data-hc-action="browse-directory">Browse All Chapters</button>
        <button class="btn btn-secondary btn-sm" data-hc-action="open-front-matter">Front Matter / How to Read</button>
      </div>
    `;
    focusReaderAndResetScroll();
    history.replaceState(null, '', `#system-${num}`);
  }

  // Reader Open for Appendices
  function openAppendix(slug) {
    const data = window.CHARTER_DATA;
    if (!data || !data.appendices) return;
    const appendix = data.appendices.find(a => a.slug === slug);
    if (!appendix) return;

    openReader();
    state.currentChapter = null;
    state.currentAppendix = appendix;

    document.getElementById('reader-modal-title').textContent = appendix.title;

    const tabsEl = document.getElementById('reader-tabs-container');
    tabsEl.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:8px;font-size:0.85rem;font-weight:600;color:var(--brand-olive);background:var(--brand-olive-light);padding:6px 14px;border-radius:var(--radius-sm)">
        &sect; Technical Reference (${appendix.word_count.toLocaleString()} words • ${appendix.read_time} min read)
      </span>
    `;

    const bodyEl = document.getElementById('reader-body-content');
    bodyEl.innerHTML = `
      <div style="font-size:0.9rem;color:var(--text-muted);margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid var(--border-subtle);line-height:1.5">
        ${escapeHtml(appendix.subtitle || '')}
      </div>
      <div class="md-view">
        ${renderMarkdown(appendix.content)}
      </div>
      <div style="margin-top:36px;padding-top:20px;border-top:1px solid var(--border-subtle);text-align:center">
        <button class="btn btn-secondary btn-sm" data-hc-action="close-reader">
          ✕ Close Technical Reference
        </button>
      </div>
    `;
    focusReaderAndResetScroll();

    history.replaceState(null, '', `#appendix-${slug}`);
  }

  function openFrontMatter() {
    const data = window.CHARTER_DATA;
    if (typeof data?.front_matter !== 'string') return;

    openReader();
    state.currentChapter = null;
    state.currentAppendix = null;
    document.getElementById('reader-modal-title').textContent = 'Humanity’s Charter';
    document.getElementById('reader-tabs-container').innerHTML = `
      <span class="front-matter-reader-label">Front matter / How to read the Charter</span>
    `;
    document.getElementById('reader-body-content').innerHTML = `
      <div class="md-view">${renderMarkdown(data.front_matter)}</div>
      <div class="reader-close-row">
        <button class="btn btn-primary btn-sm" data-hc-action="open-chapter" data-chapter="1">Start Chapter 1</button>
        <button class="btn btn-secondary btn-sm" data-hc-action="browse-directory">Browse All Chapters</button>
        <button class="btn btn-secondary btn-sm" data-hc-action="close-reader">Close Charter</button>
      </div>
    `;
    focusReaderAndResetScroll();
    history.replaceState(null, '', '#front-matter');
  }

  function closeReader() {
    getReaderOverlay()?.classList.remove('open');
    document.body.style.overflow = '';
    state.currentChapter = null;
    state.currentAppendix = null;
    history.replaceState(null, '', window.location.pathname);
    const opener = state.readerOpener;
    state.readerOpener = null;
    if (opener?.isConnected !== false) opener?.focus();
  }

  // Render Reader Body (Exec vs Full for Chapters)
  function renderReaderBody() {
    const ch = state.currentChapter;
    if (!ch) return;

    const bodyEl = document.getElementById('reader-body-content');
    const tabsEl = document.getElementById('reader-tabs-container');

    tabsEl.innerHTML = `
      <button class="tab-btn ${state.readerMode === 'exec' ? 'active' : ''}" data-hc-action="set-mode" data-mode="exec">
        Chapter Summary (3 min)
      </button>
      <button class="tab-btn ${state.readerMode === 'full' ? 'active' : ''}" data-hc-action="set-mode" data-mode="full">
        Full Chapter (${ch.read_time} min)
      </button>
    `;

    if (state.readerMode === 'exec') {
      const pillarsHtml = (ch.key_pillars && ch.key_pillars.length)
        ? `<div class="exec-pillars">
            ${ch.key_pillars.map((pillar, idx) => `
              <div class="exec-pillar-card">
                <div class="exec-pillar-badge">${idx + 1}</div>
                <div class="exec-pillar-text">${renderInline(pillar)}</div>
              </div>
            `).join('')}
          </div>`
        : `<div class="md-view">${renderMarkdown(ch.content.slice(0, 1800) + '...')}</div>`;

      const breakthroughHtml = ch.breakthrough_mechanism ? `
        <div class="exec-box breakthrough">
          <h4>&sect; Proposed Approach</h4>
          <p style="font-size:1.05rem;line-height:1.65;color:var(--text-primary);margin-bottom:0">
            ${renderInline(ch.breakthrough_mechanism)}
          </p>
        </div>
      ` : '';

      const debateHtml = ch.core_debate ? `
        <div class="exec-box debate">
          <h4>&sect; Open Question & Debate</h4>
          <p style="font-size:1.05rem;line-height:1.65;color:var(--text-primary);margin-bottom:14px">
            ${renderInline(ch.core_debate)}
          </p>
          <button class="btn btn-primary btn-sm" data-hc-action="open-proposal" data-chapter="${ch.num}">
            Propose an Amendment to Chapter ${ch.num} &rarr;
          </button>
        </div>
      ` : '';

      bodyEl.innerHTML = `
        <div style="font-size:0.85rem;color:var(--text-muted);margin-bottom:16px">
          ${escapeHtml(ch.part_title)} • AI-assisted chapter summary • 3 min read
        </div>

        <div class="exec-box" style="border-left:4px solid var(--brand-terracotta)">
          <h4>Core Premise (Summary)</h4>
          <p style="font-size:1.15rem;font-weight:500;line-height:1.65;color:var(--text-primary);margin-bottom:0">
            ${renderInline(ch.core_premise || ch.subtitle)}
          </p>
        </div>

        <div style="margin:28px 0 20px;">
          <h3 style="margin-bottom:6px">Key Pillars</h3>
          <p style="font-size:0.9rem;color:var(--text-muted);margin-bottom:16px">A short outline of the chapter's main proposals. Read the full chapter for the reasoning, evidence, and limits.</p>
          ${pillarsHtml}
        </div>

        ${breakthroughHtml}

        ${debateHtml}

        <div class="full-dossier-banner">
          <div class="banner-text">
            <strong style="font-size:1rem;color:var(--text-primary);display:block;margin-bottom:4px">Ready to read the complete chapter?</strong>
            <span style="font-size:0.85rem;color:var(--text-muted)">Explore the unabridged text, institutional designs, and core arguments (${ch.word_count.toLocaleString()} words).</span>
          </div>
          <button class="btn btn-secondary btn-sm" data-hc-action="set-mode" data-mode="full">
            Read Full Chapter (${ch.read_time} min) &rarr;
          </button>
        </div>

        ${renderReactionControls(ch.num, reactionClient.get(ch.num))}
      `;
    } else {
      bodyEl.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid var(--border-subtle);flex-wrap:wrap;gap:10px">
          <div style="font-size:0.85rem;color:var(--text-muted)">
            ${escapeHtml(ch.part_title)} • ${ch.word_count.toLocaleString()} words • Unabridged Chapter Text
          </div>
          <button class="btn btn-secondary btn-sm" data-hc-action="set-mode" data-mode="exec">
            Switch to Chapter Summary (3 min)
          </button>
        </div>
        <div class="md-view">
          ${renderMarkdown(ch.content)}
        </div>
        ${renderReactionControls(ch.num, reactionClient.get(ch.num))}
      `;
    }
  }

  function updateVisibleReactions(chapter = null) {
    document.querySelectorAll('.reaction-controls').forEach(element => {
      const number = Number(element.dataset.chapter);
      if (chapter !== null && number !== chapter) return;
      const compact = element.dataset.compact === 'true';
      element.outerHTML = renderReactionControls(number, reactionClient.get(number), compact);
    });
  }

  async function react(chapter, reaction) {
    const source = document.activeElement?.closest?.('.reaction-controls');
    const compact = source?.dataset.compact;
    await reactionClient.choose(chapter, reaction);
    if (source && document.activeElement === document.body) {
      document.querySelector(`.reaction-controls[data-chapter="${chapter}"][data-compact="${compact}"] .reaction-choice[data-reaction="${reaction}"]`)?.focus();
    }
  }

  // Sincerity Modal
  function openSincerityModal() {
    const data = window.CHARTER_DATA;
    if (!data) return;
    const bodyEl = document.getElementById('sincerity-modal-content');
    bodyEl.innerHTML = `
      <div class="md-view">
        ${renderMarkdown(data.sincerity_statement)}
      </div>
    `;
    document.getElementById('sincerity-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeSincerityModal() {
    document.getElementById('sincerity-overlay').classList.remove('open');
    document.body.style.overflow = '';
  }

  // Proposal Handler
  function openProposalForChapter(num, title) {
    closeReader();
    const select = document.getElementById('proposal-chapter');
    if (select) {
      select.value = num;
    }
    const proposeSection = document.getElementById('propose');
    if (proposeSection) {
      proposeSection.scrollIntoView({ behavior: 'smooth' });
    }
  }

  function setReaderMode(mode) {
    if (mode !== 'exec' && mode !== 'full') return;
    state.readerMode = mode;
    renderReaderBody();
    const modeControl = readerDialog()?.querySelector(`[data-hc-action="set-mode"][data-mode="${mode}"]`);
    (modeControl ?? readerDialog())?.focus();
    const readerContent = getReaderOverlay()?.querySelector('.reader-content');
    if (readerContent) readerContent.scrollTop = 0;
  }

  function navigateCitation(targetId) {
    if (!/^citation-(?:source-\d+|return-\d+-\d+)$/u.test(targetId || '')) return;
    const overlay = getReaderOverlay();
    if (!overlay?.classList.contains('open')) return;
    const readerContent = overlay.querySelector('.reader-content');
    const target = readerContent?.querySelector(`#${targetId}`);
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }

  function handleAction(event) {
    const target = event.target.closest?.('[data-hc-action]');
    if (!target) return;
    const action = target.dataset.hcAction;
    const chapter = Number(target.dataset.chapter);
    const system = Number(target.dataset.system);
    const slug = target.dataset.slug;

    if (target.tagName === 'A') event.preventDefault();
    if (action === 'open-chapter' && Number.isInteger(chapter) && chapter >= 1 && chapter <= 26) openChapter(chapter);
    if (action === 'open-system' && Number.isInteger(system) && system >= 1 && system <= 8) openSystem(system);
    if (action === 'open-appendix' && /^[a-z0-9-]+$/u.test(slug || '')) openAppendix(slug);
    if (action === 'open-front-matter') openFrontMatter();
    if (action === 'close-reader') closeReader();
    if (action === 'browse-directory') {
      closeReader();
      document.getElementById('directory')?.scrollIntoView({ behavior: 'smooth' });
    }
    if (action === 'open-sincerity') openSincerityModal();
    if (action === 'close-sincerity') closeSincerityModal();
    if (action === 'set-mode') setReaderMode(target.dataset.mode);
    if (action === 'citation-source' || action === 'citation-return') navigateCitation(target.dataset.citationTarget);
    if (action === 'open-proposal' && Number.isInteger(chapter) && chapter >= 1 && chapter <= 26) openProposalForChapter(chapter);
    if (action === 'react' && Number.isInteger(chapter) && chapter >= 1 && chapter <= 26
      && ['agree', 'disagree', 'propose_change'].includes(target.dataset.reaction)) {
      react(chapter, target.dataset.reaction);
    }
  }

  // Comprehensive, Bulletproof Search
  function handleSearch(e) {
    const q = (e ? e.target.value : '').toLowerCase().trim();
    const data = window.CHARTER_DATA;
    if (!data) return;

    if (!q) {
      renderDirectory(data.chapters || []);
      if (data.appendices) renderAppendices(data.appendices);
      return;
    }

    // Filter chapters safely across multiple fields
    const filteredChapters = (data.chapters || []).filter(c => {
      const title = (c.title || '').toLowerCase();
      const subtitle = (c.subtitle || '').toLowerCase();
      const premise = (c.core_premise || '').toLowerCase();
      const numStr = `chapter ${c.num}`;
      const pillars = (c.key_pillars || []).join(' ').toLowerCase();
      const mech = (c.breakthrough_mechanism || '').toLowerCase();
      const debate = (c.core_debate || '').toLowerCase();

      return title.includes(q) || 
             subtitle.includes(q) || 
             premise.includes(q) || 
             numStr.includes(q) || 
             pillars.includes(q) || 
             mech.includes(q) || 
             debate.includes(q);
    });

    renderDirectory(filteredChapters);

    // Also filter appendices in real time
    if (data.appendices) {
      const filteredAppendices = data.appendices.filter(a => {
        const title = (a.title || '').toLowerCase();
        const subtitle = (a.subtitle || '').toLowerCase();
        const letter = (a.letter || '').toLowerCase();
        const slug = (a.slug || '').toLowerCase();
        return title.includes(q) || 
               subtitle.includes(q) || 
               `appendix ${letter}`.includes(q) || 
               slug.includes(q);
      });
      renderAppendices(filteredAppendices);
    }

  }

  // Handle URL Hash Navigation
  function handleHashChange() {
    const hash = window.location.hash;
    if (!hash) return;

    if (hash === '#energy' || hash.startsWith('#evidence-')) {
      openAppendix('appendix-energy-fission-eroei-calculation');
    } else if (hash === '#front-matter') {
      openFrontMatter();
    } else if (/^#system-[1-8]$/u.test(hash)) {
      openSystem(Number(hash.replace('#system-', '')));
    } else if (hash.startsWith('#appendix-')) {
      const slug = hash.replace('#appendix-', '');
      if (slug) openAppendix(slug);
    } else if (hash.startsWith('#chapter-')) {
      const chNum = parseInt(hash.replace('#chapter-', ''), 10);
      if (chNum) openChapter(chNum);
    }
  }

  // Initialize
  function init() {
    applyTheme(state.theme);
    document.addEventListener('click', handleAction);
    document.addEventListener('keydown', event => {
      const overlay = getReaderOverlay();
      if (overlay?.classList.contains('open')) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeReader();
          return;
        }
        if (event.key === 'Tab') {
          const focusable = readerFocusableElements();
          if (focusable.length === 0) {
            event.preventDefault();
            readerDialog()?.focus();
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          const activeInside = overlay.contains(document.activeElement);
          if ((event.shiftKey && (!activeInside || document.activeElement === first))
            || (!event.shiftKey && (!activeInside || document.activeElement === last))) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          }
          return;
        }
      }
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('[role="button"][data-hc-action]')) {
        event.preventDefault();
        handleAction(event);
      }
    });

    const data = window.CHARTER_DATA;
    if (data && data.chapters) {
      renderSystems();
      renderDirectory(data.chapters);
      reactionClient.subscribe(updateVisibleReactions);
      reactionClient.load();
      if (data.appendices) {
        renderAppendices(data.appendices);
      }
      // Populate Chapter dropdown in proposal form
      const select = document.getElementById('proposal-chapter');
      if (select) {
        select.innerHTML = data.chapters.map(c => `
          <option value="${c.num}">Chapter ${c.num}: ${escapeHtml(c.title)}</option>
        `).join('');
      }
    }

    // Event Listeners
    const themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const next = state.theme === 'light' ? 'dark' : 'light';
        state.theme = next;
        applyTheme(next);
      });
    }

    const searchInput = document.getElementById('chapter-search');
    if (searchInput) {
      searchInput.addEventListener('input', handleSearch);
    }

    const propForm = document.getElementById('proposal-form-el');
    if (propForm) {
      const proposalController = createProposalController(proposalElements(document), {
        client: proposalClient,
        siteKey: TURNSTILE_SITE_KEY
      });
      if (proposalController.configurationReady) {
        loadTurnstile(document, window)
          .then(api => proposalController.setTurnstile(api))
          .catch(() => proposalController.setTurnstile(null));
      }
    }

    // Mobile Navigation Drawer Toggle & Auto-Close
    const menuToggle = document.getElementById('mobile-menu-toggle');
    const siteNav = document.getElementById('site-nav');
    if (menuToggle && siteNav) {
      menuToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = siteNav.classList.toggle('open');
        menuToggle.textContent = isOpen ? '✕' : '☰';
        menuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      });

      // Auto-close menu when tapping navigation links
      siteNav.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
          siteNav.classList.remove('open');
          menuToggle.textContent = '☰';
          menuToggle.setAttribute('aria-expanded', 'false');
        });
      });

      // Close menu when tapping outside
      document.addEventListener('click', (e) => {
        if (!siteNav.contains(e.target) && !menuToggle.contains(e.target)) {
          siteNav.classList.remove('open');
          menuToggle.textContent = '☰';
          menuToggle.setAttribute('aria-expanded', 'false');
        }
      });
    }

    // Close modals on backdrop click
    const readerOverlay = document.getElementById('reader-overlay');
    if (readerOverlay) {
      readerOverlay.addEventListener('click', (e) => {
        if (e.target === readerOverlay) {
          closeReader();
        }
      });
    }

    const sincerityOverlay = document.getElementById('sincerity-overlay');
    if (sincerityOverlay) {
      sincerityOverlay.addEventListener('click', (e) => {
        if (e.target === sincerityOverlay) {
          closeSincerityModal();
        }
      });
    }

    // Listen for hash changes
    window.addEventListener('hashchange', handleHashChange);

    // Initial check of hash
    setTimeout(handleHashChange, 120);
  }

  // Expose Global Public API
  window.HC = {
    openChapter,
    openSystem,
    openAppendix,
    openFrontMatter,
    closeReader,
    setMode: setReaderMode,
    react,
    openSincerityModal,
    closeSincerityModal,
    openProposalForChapter
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
