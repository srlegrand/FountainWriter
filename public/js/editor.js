'use strict';

// ── Constants ─────────────────────────────────────────────────
const PROJECT_NAME = window.location.pathname.split('/').pop();
const API = '/api';

function getFileParam() {
  return new URLSearchParams(window.location.search).get('file');
}
const AUTO_SAVE_DELAY  = 8000;   // ms after last keystroke
const AUTO_COMMIT_DELAY_DEFAULT = 5 * 60 * 1000; // 5 min

const BLOCK_TYPES = ['action', 'scene-heading', 'character', 'transition'];
const BLOCK_LABELS = {
  'scene-heading':  'Scene Heading',
  'action':         'Action',
  'character':      'Character',
  'dialogue':       'Dialogue',
  'parenthetical':  'Parenthetical',
  'transition':     'Transition',
  'note':           'Note',
  'section':        'Section',
  'synopsis':       'Synopsis',
  'centered':       'Centered',
  'page-break':     'Page Break',
};

// Default color settings (map to CSS vars)
const COLOR_SETTINGS = [
  { key: '--c-scene',      label: 'Scene Heading', dark: '#fbbf24', light: '#92400e' },
  { key: '--c-action',     label: 'Action',        dark: '#e7e5e4', light: '#1c1917' },
  { key: '--c-character',  label: 'Character',     dark: '#6ee7b7', light: '#065f46' },
  { key: '--c-dialogue',   label: 'Dialogue',      dark: '#d6d3d1', light: '#292524' },
  { key: '--c-parens',     label: 'Parenthetical', dark: '#a78bfa', light: '#5b21b6' },
  { key: '--c-transition', label: 'Transition',    dark: '#fb7185', light: '#9f1239' },
  { key: '--c-note',       label: 'Note',          dark: '#60a5fa', light: '#1d4ed8' },
];

// ── State ─────────────────────────────────────────────────────
let state = {
  projectName: PROJECT_NAME,
  fileName: null,
  allFiles: [],
  titlePage: {},
  blocks: [],
  dirty: false,
  saveTimer: null,
  commitTimer: null,
  autoCommitEnabled: true,
  autoCommitInterval: AUTO_COMMIT_DELAY_DEFAULT,
  characters: [],
  sceneHeadings: [],
  focusMode: false,
  currentBlockEl: null,
  notes: [],           // [{id, blockIndex, highlightText, noteText, color}]
  pendingSelection: null, // selection waiting for note creation
};

const LINES_PER_PAGE = 55; // A4 at 12pt Courier with standard margins

// ── Utilities ─────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function debounce(fn, delay) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

function setCursorAtEnd(el) {
  el.focus();
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function setCursorAtStart(el) {
  el.focus();
  const range = document.createRange();
  const sel = window.getSelection();
  range.setStart(el, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function getCursorPosition(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return 0;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return range.toString().length;
}

function isAtStart(el) { return getCursorPosition(el) === 0; }
function isAtEnd(el)   { return getCursorPosition(el) === el.textContent.length; }

// ── Theme ─────────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('fw-theme', t);
  const icon = t === 'dark' ? '☀️' : '🌙';
  const label = t === 'dark' ? 'Light' : 'Dark';
  document.getElementById('themeToggleBtn').textContent = icon;
  if (document.getElementById('themeIconSettings')) {
    document.getElementById('themeIconSettings').textContent = icon;
    document.getElementById('themeLabelSettings').textContent = label;
  }
  applyCustomColors(t);
}

function applyCustomColors(theme) {
  const root = document.documentElement;
  for (const c of COLOR_SETTINGS) {
    const stored = localStorage.getItem(`fw-color-${theme}-${c.key}`);
    root.style.setProperty(c.key, stored || (theme === 'dark' ? c.dark : c.light));
  }
}

// ── Block Factory ─────────────────────────────────────────────
function createBlockElement(type, text) {
  const el = document.createElement('div');
  el.className = 'fountain-block';
  el.dataset.type = type;
  el.dataset.typeLabel = BLOCK_LABELS[type] || type;
  el.contentEditable = 'true';
  el.spellcheck = true;
  el.textContent = text || '';

  // Specific aria roles
  el.setAttribute('role', 'textbox');
  el.setAttribute('aria-label', BLOCK_LABELS[type] || type);
  el.setAttribute('aria-multiline', 'true');

  attachBlockListeners(el);
  return el;
}

function getBlockType(el) { return el.dataset.type; }

function setBlockType(el, type) {
  el.dataset.type = type;
  el.dataset.typeLabel = BLOCK_LABELS[type] || type;
  el.setAttribute('aria-label', BLOCK_LABELS[type] || type);
  updateStatusBar();
}

function getAllBlocks() {
  return [...document.querySelectorAll('#blocksContainer .fountain-block')];
}

function getPrevBlock(el) {
  const blocks = getAllBlocks();
  const idx = blocks.indexOf(el);
  return idx > 0 ? blocks[idx - 1] : null;
}

function getNextBlock(el) {
  const blocks = getAllBlocks();
  const idx = blocks.indexOf(el);
  return idx < blocks.length - 1 ? blocks[idx + 1] : null;
}

function insertBlockAfter(refEl, type, text) {
  const newEl = createBlockElement(type, text || '');
  if (refEl) {
    refEl.after(newEl);
  } else {
    document.getElementById('blocksContainer').appendChild(newEl);
  }
  return newEl;
}

function deleteBlock(el) {
  const prev = getPrevBlock(el);
  el.remove();
  if (prev) setCursorAtEnd(prev);
  else {
    const first = getAllBlocks()[0];
    if (first) setCursorAtStart(first);
  }
  scheduleSave();
}

function mergeWithPrev(el) {
  const prev = getPrevBlock(el);
  if (!prev) return;
  const prevText = prev.textContent;
  const curText  = el.textContent;
  const combined = prevText + curText;
  prev.textContent = combined;
  el.remove();

  // Restore cursor position
  const range = document.createRange();
  const sel = window.getSelection();
  const textNode = prev.firstChild || prev;
  const offset = prevText.length;
  try {
    range.setStart(textNode, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch { setCursorAtEnd(prev); }
  scheduleSave();
}

// ── Tab Cycling ───────────────────────────────────────────────
const CYCLE_ORDER = ['action', 'scene-heading', 'character', 'transition'];
const CYCLE_ORDER_REV = [...CYCLE_ORDER].reverse();

function cycleBlockType(el, reverse = false) {
  const current = getBlockType(el);
  const order = reverse ? CYCLE_ORDER_REV : CYCLE_ORDER;
  const idx = order.indexOf(current);
  const next = idx === -1 ? order[0] : order[(idx + 1) % order.length];
  setBlockType(el, next);
  updateStatusBar();
  scheduleSave();
}

// Context-aware Enter: what type should the next block be?
function getNextTypeForEnter(currentType) {
  switch (currentType) {
    case 'scene-heading': return 'action';
    case 'action':        return 'action';
    case 'character':     return 'dialogue';
    case 'dialogue':      return 'action';   // blank dialogue → action; non-blank → dialogue handled below
    case 'parenthetical': return 'dialogue';
    case 'transition':    return 'scene-heading';
    default:              return 'action';
  }
}

// ── Keyboard Handling ─────────────────────────────────────────
function attachBlockListeners(el) {
  el.addEventListener('keydown', handleKeydown);
  el.addEventListener('input', handleInput);
  el.addEventListener('focus', handleFocus);
  el.addEventListener('blur',  handleBlur);
  el.addEventListener('paste', handlePaste);
}

function handleFocus(e) {
  state.currentBlockEl = e.target;
  updateStatusBar();
  updateAutocomplete(e.target);
}

function handleBlur() {
  hideAutocomplete();
}

function handleInput(e) {
  updateAutocomplete(e.target);
  autoDetectType(e.target);
  scheduleSave();
  scheduleStatsUpdate();
  debouncedPageBreaks();
}

function handlePaste(e) {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
}

function handleKeydown(e) {
  const el = e.target;

  // Autocomplete navigation
  if (isAutocompleteVisible()) {
    if (e.key === 'ArrowDown') { e.preventDefault(); autocompleteSelectNext(); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); autocompleteSelectPrev(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (autocompleteHasSelection()) {
        e.preventDefault();
        autocompleteConfirm(el);
        if (e.key === 'Enter') handleEnterAfterAutocomplete(el);
        return;
      }
    }
    if (e.key === 'Escape') { hideAutocomplete(); return; }
  }

  // Save / commit
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveAndCommit();
    return;
  }

  // Tab: cycle element type
  if (e.key === 'Tab') {
    e.preventDefault();
    if (e.shiftKey) cycleBlockType(el, true);
    else            cycleBlockType(el, false);
    return;
  }

  // Enter: new block
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleEnterKey(el);
    return;
  }

  // Backspace at start of block: merge with previous
  if (e.key === 'Backspace' && isAtStart(el) && el.textContent.length > 0 === false) {
    e.preventDefault();
    const prev = getPrevBlock(el);
    if (prev) {
      el.remove();
      setCursorAtEnd(prev);
      scheduleSave();
    }
    return;
  }
  if (e.key === 'Backspace' && isAtStart(el) && el.textContent.length > 0) {
    // cursor at start but block has text: merge
    e.preventDefault();
    mergeWithPrev(el);
    return;
  }

  // Delete at end of block: merge next into this
  if (e.key === 'Delete' && isAtEnd(el)) {
    e.preventDefault();
    const next = getNextBlock(el);
    if (next) {
      el.textContent = el.textContent + next.textContent;
      next.remove();
      setCursorAtEnd(el);
      scheduleSave();
    }
    return;
  }

  // Arrow up: move to previous block
  if (e.key === 'ArrowUp' && isAtStart(el)) {
    e.preventDefault();
    const prev = getPrevBlock(el);
    if (prev) setCursorAtEnd(prev);
    return;
  }

  // Arrow down: move to next block
  if (e.key === 'ArrowDown' && isAtEnd(el)) {
    e.preventDefault();
    const next = getNextBlock(el);
    if (next) setCursorAtStart(next);
    return;
  }
}

function handleEnterKey(el) {
  const type = getBlockType(el);
  const text = el.textContent;
  const pos = getCursorPosition(el);
  const textBefore = text.substring(0, pos);
  const textAfter  = text.substring(pos);

  // Split the current block at cursor
  if (textAfter) {
    el.textContent = textBefore;
  }

  let nextType = getNextTypeForEnter(type);

  // If dialogue is non-empty and we're in the middle, stay as dialogue
  if (type === 'dialogue' && textBefore.trim() && textAfter.trim()) {
    nextType = 'dialogue';
  }

  const newEl = insertBlockAfter(el, nextType, textAfter);
  setCursorAtStart(newEl);
  scheduleSave();
  scheduleStatsUpdate();
}

function handleEnterAfterAutocomplete(el) {
  const type = getBlockType(el);
  const nextType = getNextTypeForEnter(type);
  const newEl = insertBlockAfter(el, nextType, '');
  setCursorAtStart(newEl);
  scheduleSave();
}

// ── Auto-detect type from content ─────────────────────────────
const SCENE_RE = /^(INT|EXT|EST|INT\.\/EXT|INT\/EXT|I\/E)[\s.]/i;
const TRANS_RE = /^(FADE IN:|FADE OUT\.|FADE TO BLACK\.|CUT TO:|SMASH CUT TO:|MATCH CUT TO:|JUMP CUT TO:)$/;

function autoDetectType(el) {
  const text = el.textContent.trim().toUpperCase();
  const current = getBlockType(el);

  // Don't auto-detect if user manually cycled to a type
  if (['character', 'dialogue', 'parenthetical'].includes(current)) return;

  if (SCENE_RE.test(text)) {
    if (current !== 'scene-heading') setBlockType(el, 'scene-heading');
  } else if (TRANS_RE.test(text)) {
    if (current !== 'transition') setBlockType(el, 'transition');
  }
}

// ── Autocomplete ──────────────────────────────────────────────
let acState = { visible: false, items: [], selectedIdx: -1 };
const acDropdown = document.getElementById('autocompleteDropdown');

function updateAutocomplete(el) {
  const type = getBlockType(el);
  const text = el.textContent.trim().toUpperCase();

  if (!text) { hideAutocomplete(); return; }

  let suggestions = [];

  if (type === 'character') {
    suggestions = state.characters.filter(c => c.startsWith(text) && c !== text);
  } else if (type === 'scene-heading') {
    if (!text.startsWith('INT') && !text.startsWith('EXT') && !text.startsWith('EST')) {
      suggestions = ['INT. ', 'EXT. ', 'INT./EXT. ', 'EST. '].filter(p => p.startsWith(text));
    } else {
      suggestions = state.sceneHeadings.filter(s => s.startsWith(text) && s !== text);
    }
  }

  if (suggestions.length === 0) { hideAutocomplete(); return; }

  acState.items = suggestions.slice(0, 6);
  acState.selectedIdx = -1;
  renderAutocomplete(el);
}

function renderAutocomplete(el) {
  acDropdown.innerHTML = acState.items.map((item, i) =>
    `<div class="autocomplete-item${i === acState.selectedIdx ? ' selected' : ''}" data-idx="${i}">${item}</div>`
  ).join('');

  // Position below the current block
  const rect = el.getBoundingClientRect();
  acDropdown.style.left = `${rect.left}px`;
  acDropdown.style.top  = `${rect.bottom + 4}px`;
  acDropdown.style.display = 'block';
  acState.visible = true;

  acDropdown.querySelectorAll('.autocomplete-item').forEach(item => {
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      acState.selectedIdx = parseInt(item.dataset.idx);
      const focused = state.currentBlockEl;
      if (focused) {
        autocompleteConfirm(focused);
        handleEnterAfterAutocomplete(focused);
      }
    });
  });
}

function hideAutocomplete() {
  acDropdown.style.display = 'none';
  acState.visible = false;
  acState.selectedIdx = -1;
}

function isAutocompleteVisible() { return acState.visible && acState.items.length > 0; }
function autocompleteHasSelection() { return acState.selectedIdx >= 0; }

function autocompleteSelectNext() {
  acState.selectedIdx = (acState.selectedIdx + 1) % acState.items.length;
  renderAutocomplete(state.currentBlockEl);
}
function autocompleteSelectPrev() {
  acState.selectedIdx = (acState.selectedIdx - 1 + acState.items.length) % acState.items.length;
  renderAutocomplete(state.currentBlockEl);
}

function autocompleteConfirm(el) {
  const val = acState.items[acState.selectedIdx];
  if (!val) return;
  el.textContent = val;
  setCursorAtEnd(el);
  hideAutocomplete();
  scheduleSave();
}

// ── Rendering ─────────────────────────────────────────────────
function renderTitlePage(tp) {
  const block = document.getElementById('titlePageBlock');
  if (!tp || Object.keys(tp).length === 0) {
    block.style.display = 'none';
    return;
  }
  block.style.display = '';
  const title  = tp.title  || '';
  const credit = tp.credit || 'Written by';
  const author = tp.author || '';
  const source = tp.source || '';
  const draftDate = tp.draft_date || tp.draftdate || '';
  const contact   = tp.contact || '';

  block.innerHTML = `
    <div class="tp-title">${escapeHtml(title)}</div>
    <div class="tp-credit">${escapeHtml(credit)}</div>
    <div class="tp-author">${escapeHtml(author)}</div>
    ${source ? `<div class="tp-source">${escapeHtml(source)}</div>` : ''}
    ${draftDate || contact ? `<div class="tp-meta">
      ${draftDate ? `<div>${escapeHtml(draftDate)}</div>` : ''}
      ${contact ? `<div>${escapeHtml(contact)}</div>` : ''}
    </div>` : ''}
  `;
}

function renderBlocks(blocks) {
  const container = document.getElementById('blocksContainer');
  container.innerHTML = '';

  for (const b of blocks) {
    const el = createBlockElement(b.type, b.text || '');
    container.appendChild(el);
  }

  if (container.children.length === 0) {
    container.appendChild(createBlockElement('action', ''));
  }
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ── Serialization ─────────────────────────────────────────────
function collectBlockData() {
  return getAllBlocks().map(el => ({
    type: el.dataset.type,
    text: el.textContent.trim()
  })).filter(b => b.text || b.type === 'page-break');
}

function serializeToFountain() {
  const blocks = collectBlockData();
  return Fountain.serialize(state.titlePage, blocks);
}

// ── Save & Commit ─────────────────────────────────────────────
function setSaveStatus(status, text) {
  const el = document.getElementById('saveStatus');
  el.className = `save-status ${status}`;
  document.getElementById('saveStatusText').textContent = text;
}

const debouncedSave = debounce(saveFile, AUTO_SAVE_DELAY);

function scheduleSave() {
  state.dirty = true;
  setSaveStatus('saving', 'Unsaved');
  debouncedSave();
}

async function saveFile() {
  if (!state.fileName) return;
  const content = serializeToFountain();
  try {
    setSaveStatus('saving', 'Saving…');
    const res = await fetch(`${API}/projects/${encodeURIComponent(state.projectName)}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, fileName: state.fileName })
    });
    if (!res.ok) throw new Error('Save failed');
    state.dirty = false;
    setSaveStatus('saved', 'Saved');
    // Update local knowledge of chars/scenes for autocomplete
    extractMetadata();
  } catch (err) {
    setSaveStatus('error', 'Error');
    console.error('Save error:', err);
  }
}

async function saveAndCommit(message) {
  await saveFile();
  const msg = message || `Checkpoint: ${new Date().toLocaleString()}`;
  try {
    const res = await fetch(`${API}/projects/${encodeURIComponent(state.projectName)}/git/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg })
    });
    const data = await res.json();
    if (data.message === 'Nothing to commit') {
      toast('Nothing new to commit', 'info');
    } else {
      toast('Committed to git', 'success');
    }
    loadGitStatus();
  } catch (err) {
    toast('Git commit failed', 'error');
  }
}

function startAutoCommit() {
  stopAutoCommit();
  if (!state.autoCommitEnabled) return;
  state.commitTimer = setInterval(() => {
    if (state.dirty || document.hasFocus()) saveAndCommit();
  }, state.autoCommitInterval);
}

function stopAutoCommit() {
  if (state.commitTimer) clearInterval(state.commitTimer);
}

// ── Stats & Sidebar ───────────────────────────────────────────
const debouncedStatsUpdate = debounce(updateAll, 1000);
function scheduleStatsUpdate() { debouncedStatsUpdate(); }

function extractMetadata() {
  const blocks = collectBlockData();
  state.characters   = Fountain.extractCharacters(blocks);
  state.sceneHeadings = Fountain.extractSceneHeadings(blocks);
}

function updateAll() {
  extractMetadata();
  updateSceneList();
  updateCharList();
  updateStats();
}

function updateSceneList() {
  const blocks = getAllBlocks();
  const list = document.getElementById('sceneList');
  list.innerHTML = '';
  let sceneNum = 0;

  for (const el of blocks) {
    if (el.dataset.type === 'scene-heading' && el.textContent.trim()) {
      sceneNum++;
      const item = document.createElement('div');
      item.className = 'scene-item';
      item.innerHTML = `<span class="scene-num">${sceneNum}</span><span class="scene-text">${escapeHtml(el.textContent.trim())}</span>`;
      item.addEventListener('click', () => {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();
      });
      list.appendChild(item);
    }
  }

  document.getElementById('sceneCount').textContent = sceneNum;
}

function updateCharList() {
  const list = document.getElementById('charList');
  list.innerHTML = '';

  const blocks = collectBlockData();
  const charCounts = {};
  for (const b of blocks) {
    if (b.type === 'character' && b.text) {
      const name = b.text.toUpperCase().replace(/\s*\(.*\)$/, '').trim();
      charCounts[name] = (charCounts[name] || 0) + 1;
    }
  }

  const chars = Object.entries(charCounts).sort((a, b) => b[1] - a[1]);

  if (chars.length === 0) {
    list.innerHTML = '<div style="font-size:0.75rem;color:var(--text-4);padding:0.25rem 0.5rem">No characters yet</div>';
    return;
  }

  for (const [name, count] of chars) {
    const item = document.createElement('div');
    item.className = 'char-item';
    item.innerHTML = `<span class="char-name">${escapeHtml(name)}</span><span class="char-count">${count}</span>`;
    item.addEventListener('click', () => {
      // Find first block with this character
      const blocks = getAllBlocks();
      const found = blocks.find(b => b.dataset.type === 'character' &&
        b.textContent.trim().toUpperCase() === name);
      if (found) { found.scrollIntoView({ behavior: 'smooth', block: 'center' }); found.focus(); }
    });
    list.appendChild(item);
  }
}

function updateStats() {
  const blocks = collectBlockData();
  const pages   = Fountain.estimatePages(blocks);
  const words   = Fountain.countWords(blocks);
  const scenes  = blocks.filter(b => b.type === 'scene-heading').length;
  const chars   = new Set(blocks.filter(b => b.type === 'character').map(b => b.text.toUpperCase())).size;

  document.getElementById('statPages').textContent  = pages;
  document.getElementById('statScenes').textContent = scenes;
  document.getElementById('statWords').textContent  = words;
  document.getElementById('statChars').textContent  = chars;
  document.getElementById('statusWordCount').textContent = words;
  document.getElementById('statusPage').textContent = pages;
}

function updateStatusBar() {
  const el = state.currentBlockEl;
  if (!el) return;
  const type = el.dataset.type || 'action';
  const label = BLOCK_LABELS[type] || type;
  document.getElementById('statusElementType').textContent = label;

  // Line number
  const blocks = getAllBlocks();
  const idx = blocks.indexOf(el);
  document.getElementById('statusLine').textContent = idx + 1;
}

async function loadGitStatus() {
  try {
    const res = await fetch(`${API}/projects/${encodeURIComponent(state.projectName)}/git/status`);
    if (!res.ok) return;
    const data = await res.json();

    const badge = document.getElementById('gitBadge');
    const area = document.getElementById('gitStatusArea');

    if (data.clean) {
      badge.className = 'badge badge-green';
      badge.textContent = 'clean';
    } else {
      badge.className = 'badge badge-amber';
      badge.textContent = 'changes';
    }

    area.innerHTML = `
      <div class="git-status-row">
        <div class="dot" style="width:6px;height:6px;border-radius:50%;background:${data.clean ? 'var(--green)' : 'var(--accent)'}"></div>
        <span>${data.clean ? 'No uncommitted changes' : `${data.modified?.length || 0} file(s) modified`}</span>
      </div>
      ${data.remotes?.length ? `<div style="font-size:0.72rem;color:var(--text-3);margin-top:0.3rem">Remote: ${escapeHtml(data.remotes[0]?.refs?.fetch || data.remotes[0]?.name || '')}</div>` : ''}
    `;

    const logEl = document.getElementById('gitLog');
    logEl.innerHTML = '';
    for (const entry of (data.log || []).slice(0, 5)) {
      const item = document.createElement('div');
      item.className = 'git-log-item';
      item.innerHTML = `<span class="hash">${entry.hash?.substring(0, 7)}</span> ${escapeHtml(entry.message || '').substring(0, 40)}`;
      logEl.appendChild(item);
    }

    // Update current remotes in settings
    renderCurrentRemotes(data.remotes || []);
  } catch {}
}

function renderCurrentRemotes(remotes) {
  const el = document.getElementById('currentRemotes');
  if (!el) return;
  el.innerHTML = '';
  for (const r of remotes) {
    const div = document.createElement('div');
    div.className = 'git-remote-item';
    div.innerHTML = `<div class="remote-name">${escapeHtml(r.name)}</div><div class="remote-url">${escapeHtml(r.refs?.fetch || '')}</div>`;
    el.appendChild(div);
  }
}

// ── Page Breaks ───────────────────────────────────────────────
function lineEstimate(block) {
  const text = block.textContent || '';
  switch (block.dataset.type) {
    case 'scene-heading':  return 2; // includes preceding blank line
    case 'action':         return Math.max(1, Math.ceil(text.length / 60)) + 1;
    case 'character':      return 1;
    case 'dialogue':       return Math.max(1, Math.ceil(text.length / 35));
    case 'parenthetical':  return 1;
    case 'transition':     return 2;
    default:               return 1;
  }
}

const debouncedPageBreaks = debounce(updatePageBreaks, 600);

function updatePageBreaks() {
  // Remove existing markers
  document.querySelectorAll('.page-break-marker').forEach(e => e.remove());

  const blocks = getAllBlocks();
  let lineCount = 0;
  let pageNum = 1;

  for (const block of blocks) {
    const lines = lineEstimate(block);
    if (lineCount + lines > LINES_PER_PAGE && lineCount > 0) {
      pageNum++;
      const marker = document.createElement('div');
      marker.className = 'page-break-marker';
      marker.textContent = `page ${pageNum}`;
      block.before(marker);
      lineCount = lines;
    } else {
      lineCount += lines;
    }
  }
}

// ── Notes ─────────────────────────────────────────────────────
let noteIdCounter = Date.now();
function newNoteId() { return `n${noteIdCounter++}`; }

function noteColor(color) {
  const map = { amber: '', green: 'color-green', blue: 'color-blue', red: 'color-red', purple: 'color-purple' };
  return map[color] || '';
}

async function loadNotes() {
  try {
    const res = await fetch(`${API}/projects/${encodeURIComponent(state.projectName)}/notes?file=${encodeURIComponent(state.fileName)}`);
    state.notes = res.ok ? await res.json() : [];
  } catch { state.notes = []; }
  renderAllNotes();
}

async function saveNotes() {
  if (!state.fileName) return;
  try {
    await fetch(`${API}/projects/${encodeURIComponent(state.projectName)}/notes?file=${encodeURIComponent(state.fileName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.notes)
    });
  } catch {}
}

function getBlockIndex(el) {
  return getAllBlocks().indexOf(el);
}

function renderAllNotes() {
  const column = document.getElementById('notesColumn');
  column.innerHTML = '';

  // Re-apply marks for notes that have a highlight anchor
  document.querySelectorAll('.note-mark').forEach(m => {
    // unwrap: replace mark with its text content
    const text = document.createTextNode(m.textContent);
    m.replaceWith(text);
  });

  const blocks = getAllBlocks();
  const pageEl = document.getElementById('screenplayPage');

  for (const note of state.notes) {
    const block = blocks[note.blockIndex];
    if (block && note.highlightText) {
      applyMarkToBlock(block, note.highlightText, note.id, note.color);
    }
    column.appendChild(createNoteCard(note));
  }

  // Position all cards together so the de-overlap pass can see all heights
  positionAllNoteCards();
}

function applyMarkToBlock(block, text, noteId, color) {
  const blockText = block.textContent;
  const idx = blockText.indexOf(text);
  if (idx < 0) return;

  // Walk text nodes to find the right position
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let charCount = 0;
  let startNode = null, startOffset = 0, endNode = null, endOffset = 0;

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const len = node.textContent.length;
    if (!startNode && charCount + len > idx) {
      startNode = node;
      startOffset = idx - charCount;
    }
    if (!endNode && charCount + len >= idx + text.length) {
      endNode = node;
      endOffset = idx + text.length - charCount;
    }
    if (startNode && endNode) break;
    charCount += len;
  }

  if (!startNode || !endNode) return;

  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const mark = document.createElement('mark');
    mark.className = `note-mark ${noteColor(color)}`;
    mark.dataset.noteId = noteId;
    range.surroundContents(mark);
    mark.addEventListener('click', () => highlightNoteCard(noteId));
  } catch {}
}

function createNoteCard(note) {
  const card = document.createElement('div');
  card.className = `note-card ${noteColor(note.color)}`;
  card.dataset.noteId = note.id;

  card.innerHTML = `
    <div class="note-card-quote">${escapeHtml((note.highlightText || '').substring(0, 60))}</div>
    <div class="note-card-body" contenteditable="true" spellcheck="true">${escapeHtml(note.noteText || '')}</div>
    <div class="note-card-footer">
      <div class="note-color-dots">
        ${['amber','green','blue','red','purple'].map(c =>
          `<div class="note-color-dot ${c}${note.color === c || (!note.color && c === 'amber') ? ' active' : ''}" data-color="${c}" title="${c}"></div>`
        ).join('')}
      </div>
      <button class="note-delete-btn" title="Delete note">✕</button>
    </div>
  `;

  // Edit note text
  const body = card.querySelector('.note-card-body');
  body.addEventListener('input', () => {
    const n = state.notes.find(n => n.id === note.id);
    if (n) { n.noteText = body.textContent; saveNotes(); }
  });
  body.addEventListener('keydown', e => { if (e.key === 'Escape') body.blur(); });

  // Color picker
  card.querySelectorAll('.note-color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      const color = dot.dataset.color;
      const n = state.notes.find(n => n.id === note.id);
      if (n) {
        n.color = color;
        saveNotes();
        renderAllNotes();
      }
    });
  });

  // Delete
  card.querySelector('.note-delete-btn').addEventListener('click', () => {
    state.notes = state.notes.filter(n => n.id !== note.id);
    saveNotes();
    renderAllNotes();
  });

  return card;
}

function idealNoteTop(note, blocks, pageEl) {
  const block = blocks[note.blockIndex];
  if (!block) return 0;
  const pageRect = pageEl.getBoundingClientRect();
  const blockRect = block.getBoundingClientRect();
  return Math.max(0, blockRect.top - pageRect.top);
}

function positionAllNoteCards() {
  const blocks = getAllBlocks();
  const pageEl  = document.getElementById('screenplayPage');
  const domCards = [...document.querySelectorAll('.note-card')];
  if (!domCards.length) return;

  const GAP = 8;

  // Build items sorted by anchor (ideal) position
  const items = domCards.map(card => {
    const note = state.notes.find(n => n.id === card.dataset.noteId);
    const ideal = note ? idealNoteTop(note, blocks, pageEl) : 0;
    return { card, ideal, top: ideal, height: Math.max(card.offsetHeight || 0, 80) };
  }).sort((a, b) => a.ideal - b.ideal);

  // Forward pass — push cards down until no overlap
  for (let i = 1; i < items.length; i++) {
    const minTop = items[i - 1].top + items[i - 1].height + GAP;
    if (items[i].top < minTop) items[i].top = minTop;
  }

  // Centering pass — for each cluster of cards that got pushed together,
  // shift the whole cluster up so it straddles its collective anchor midpoint
  let i = 0;
  while (i < items.length) {
    // Grow the cluster while consecutive cards are still touching
    let j = i;
    while (j + 1 < items.length &&
           items[j].top + items[j].height + GAP > items[j + 1].ideal) {
      j++;
    }

    if (j > i) {
      const cluster = items.slice(i, j + 1);
      const idealMid = cluster.reduce((s, it) => s + it.ideal + it.height / 2, 0) / cluster.length;
      const currMid  = (cluster[0].top + cluster[cluster.length - 1].top + cluster[cluster.length - 1].height) / 2;
      const shiftUp  = Math.max(0, currMid - idealMid);

      if (shiftUp > 0) {
        const floor = i > 0 ? items[i - 1].top + items[i - 1].height + GAP : 0;
        const actual = Math.min(shiftUp, cluster[0].top - floor);
        if (actual > 0) cluster.forEach(it => { it.top -= actual; });
      }
    }

    i = j + 1;
  }

  // Apply final positions
  items.forEach(({ card, top }) => { card.style.top = `${Math.max(0, top)}px`; });
}

function highlightNoteCard(noteId) {
  document.querySelectorAll('.note-card').forEach(c => c.style.outline = '');
  document.querySelectorAll('.note-mark').forEach(m => m.classList.remove('active'));
  const card = document.querySelector(`.note-card[data-note-id="${noteId}"]`);
  if (card) {
    card.style.outline = `2px solid var(--accent)`;
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  const mark = document.querySelector(`.note-mark[data-note-id="${noteId}"]`);
  if (mark) mark.classList.add('active');
}

// ── Selection → floating note button ─────────────────────────
const floatingNoteBtn = document.getElementById('floatingNoteBtn');

function handleSelectionChange() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    floatingNoteBtn.classList.remove('visible');
    state.pendingSelection = null;
    return;
  }

  // Only show when selection is within the screenplay page
  const range = sel.getRangeAt(0);
  const page = document.getElementById('screenplayPage');
  if (!page.contains(range.commonAncestorContainer)) {
    floatingNoteBtn.classList.remove('visible');
    return;
  }

  // Position the button above the selection
  const rect = range.getBoundingClientRect();
  floatingNoteBtn.style.left = `${rect.left + rect.width / 2 - 50}px`;
  floatingNoteBtn.style.top  = `${rect.top - 38 + window.scrollY}px`;
  floatingNoteBtn.classList.add('visible');

  // Store selection info
  const blockEl = range.startContainer.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement.closest('.fountain-block')
    : range.startContainer.closest?.('.fountain-block');

  state.pendingSelection = {
    text: sel.toString().trim(),
    range: range.cloneRange(),
    blockEl,
    blockIndex: blockEl ? getBlockIndex(blockEl) : -1
  };
}

function createNoteFromSelection() {
  floatingNoteBtn.classList.remove('visible');
  const ps = state.pendingSelection;
  if (!ps || !ps.text) return;
  state.pendingSelection = null;

  const id = newNoteId();
  const note = {
    id,
    blockIndex: ps.blockIndex,
    highlightText: ps.text,
    noteText: '',
    color: 'amber'
  };

  // Apply mark immediately
  if (ps.blockEl) {
    try {
      const mark = document.createElement('mark');
      mark.className = 'note-mark';
      mark.dataset.noteId = id;
      ps.range.surroundContents(mark);
      mark.addEventListener('click', () => highlightNoteCard(id));
    } catch {}
  }

  state.notes.push(note);
  saveNotes();

  // Render the new card then re-run layout so existing cards shift if needed
  document.getElementById('notesColumn').appendChild(createNoteCard(note));
  positionAllNoteCards();

  // Focus note body for immediate typing
  setTimeout(() => {
    const body = card.querySelector('.note-card-body');
    if (body) body.focus();
  }, 50);

  // Clear selection
  window.getSelection()?.removeAllRanges();
}

// ── File Switcher ─────────────────────────────────────────────
function renderFileSwitcher() {
  const fileParam = getFileParam();
  const current = state.fileName;

  // Update button label
  document.getElementById('currentFileName').textContent = current || '—';

  // Populate dropdown list
  const list = document.getElementById('fsdFiles');
  list.innerHTML = '';

  if (state.allFiles.length === 0) {
    list.innerHTML = '<div style="padding:0.5rem 1rem;font-size:0.75rem;color:var(--text-4)">No files</div>';
    return;
  }

  for (const f of state.allFiles) {
    const item = document.createElement('div');
    item.className = 'fsd-file-item' + (f === current ? ' active' : '');
    item.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span class="fsd-file-name">${escapeHtml(f)}</span>
    `;
    if (f !== current) {
      item.addEventListener('click', () => switchToFile(f));
    }
    list.appendChild(item);
  }
}

function toggleFileSwitcher() {
  const dd = document.getElementById('fileSwitcherDropdown');
  dd.classList.toggle('open');
}

function closeFileSwitcher() {
  document.getElementById('fileSwitcherDropdown').classList.remove('open');
}

function switchToFile(fileName) {
  if (state.dirty) saveFile();
  const url = `/editor/${encodeURIComponent(state.projectName)}?file=${encodeURIComponent(fileName)}`;
  window.location.href = url;
}

async function createNewScreenplay() {
  closeFileSwitcher();
  const title = prompt('New screenplay title:');
  if (title === null) return;
  const safeName = (title || 'untitled')
    .toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').substring(0, 40);

  try {
    const res = await fetch(`${API}/projects/${encodeURIComponent(state.projectName)}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, fileName: safeName })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create screenplay');
    toast(`Created "${data.fileName}"`, 'success');
    switchToFile(data.fileName);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function triggerEditorImport() {
  closeFileSwitcher();
  document.getElementById('editorImportInput').click();
}

async function handleEditorImport(file) {
  if (!file || !file.name.endsWith('.fountain')) {
    toast('Please select a .fountain file', 'error');
    return;
  }
  const content = await file.text();
  try {
    const res = await fetch(`${API}/projects/${encodeURIComponent(state.projectName)}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, fileName: file.name.replace('.fountain', '') })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed');
    toast(`Imported "${data.fileName}"`, 'success');
    switchToFile(data.fileName);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Load Project ──────────────────────────────────────────────
async function loadProject() {
  try {
    const fileParam = getFileParam();
    const url = `${API}/projects/${encodeURIComponent(state.projectName)}/content` +
                (fileParam ? `?file=${encodeURIComponent(fileParam)}` : '');

    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not load project');
    const data = await res.json();
    state.fileName = data.fileName;
    state.allFiles = data.allFiles || [data.fileName];

    const parsed = Fountain.parse(data.content);
    state.titlePage = parsed.titlePage || {};
    state.blocks    = parsed.blocks;

    renderTitlePage(state.titlePage);
    renderBlocks(state.blocks);
    renderFileSwitcher();

    // Set title
    const title = state.titlePage?.title || state.projectName;
    document.title = `${title} — FountainWriter`;
    document.getElementById('topbarTitle').textContent = state.projectName;

    setSaveStatus('saved', 'Saved');
    updateAll();
    updatePageBreaks();
    loadGitStatus();
    loadNotes();

    // Focus first block
    const first = getAllBlocks()[0];
    if (first) first.focus();
  } catch (err) {
    toast('Failed to load project: ' + err.message, 'error');
    console.error(err);
  }
}

// ── Settings ─────────────────────────────────────────────────
function buildColorSettings() {
  const container = document.getElementById('colorSettings');
  container.innerHTML = '';

  for (const c of COLOR_SETTINGS) {
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:0.75rem';
    row.innerHTML = `
      <div style="font-size:0.8rem;color:var(--text-2);margin-bottom:0.35rem">${c.label}</div>
      <div class="color-input-row">
        <input type="color" data-key="${c.key}" title="Pick ${c.label} color" value="">
        <span style="font-size:0.72rem;color:var(--text-3)" data-preview-key="${c.key}">Custom</span>
        <button class="btn btn-ghost btn-sm" data-reset="${c.key}">Reset</button>
      </div>
    `;
    container.appendChild(row);

    const input = row.querySelector('input[type="color"]');
    const theme = document.documentElement.dataset.theme;
    const stored = localStorage.getItem(`fw-color-${theme}-${c.key}`);
    input.value = stored || (theme === 'dark' ? c.dark : c.light);

    input.addEventListener('input', () => {
      const t = document.documentElement.dataset.theme;
      localStorage.setItem(`fw-color-${t}-${c.key}`, input.value);
      document.documentElement.style.setProperty(c.key, input.value);
    });

    row.querySelector(`[data-reset]`).addEventListener('click', () => {
      const t = document.documentElement.dataset.theme;
      localStorage.removeItem(`fw-color-${t}-${c.key}`);
      const defaultVal = t === 'dark' ? c.dark : c.light;
      input.value = defaultVal;
      document.documentElement.style.setProperty(c.key, defaultVal);
    });
  }
}

function openSettings() {
  document.getElementById('settingsPanel').classList.add('open');
  buildColorSettings();
  loadGitStatus();
}

function closeSettings() {
  document.getElementById('settingsPanel').classList.remove('open');
}

// ── Export ────────────────────────────────────────────────────
function exportFountain() {
  const content = serializeToFountain();
  const blob = new Blob([content], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state.fileName || `${state.projectName}.fountain`;
  a.click();
}

// ── Sidebar Resize ────────────────────────────────────────────

function initSidebarResize() {
  const layout  = document.querySelector('.editor-layout');
  const handle  = document.getElementById('sidebarResizeHandle');
  const sidebar = document.getElementById('leftSidebar');
  const MIN_W   = 120;
  const MAX_W   = 480;

  const saved = localStorage.getItem('fw-sidebar-left-width');
  if (saved) layout.style.setProperty('--sidebar-left-w', saved + 'px');

  let startX, startW;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(e) {
      const w = Math.min(MAX_W, Math.max(MIN_W, startW + e.clientX - startX));
      layout.style.setProperty('--sidebar-left-w', w + 'px');
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('fw-sidebar-left-width', sidebar.offsetWidth);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Notes Visibility Toggle ───────────────────────────────────

function toggleNotes() {
  const hidden = document.body.classList.toggle('notes-hidden');
  const btn = document.getElementById('toggleNotesBtn');
  btn.classList.toggle('active', !hidden);
  btn.title = hidden ? 'Show notes (N)' : 'Hide notes (N)';
  localStorage.setItem('fw-notes-hidden', hidden ? '1' : '');
}

// ── Event Wiring ──────────────────────────────────────────────

// Floating note button
floatingNoteBtn.addEventListener('click', createNoteFromSelection);
document.addEventListener('selectionchange', handleSelectionChange);

// Reposition note cards on window resize (layout shifts)
window.addEventListener('resize', positionAllNoteCards);

// File switcher
document.getElementById('fileSwitcherBtn').addEventListener('click', e => {
  e.stopPropagation();
  toggleFileSwitcher();
});
document.getElementById('fsdNewBtn').addEventListener('click', createNewScreenplay);
document.getElementById('fsdImportBtn').addEventListener('click', triggerEditorImport);
document.getElementById('editorImportInput').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = ''; // reset so same file can be re-imported
  if (file) handleEditorImport(file);
});
// Close file switcher on outside click
document.addEventListener('click', e => {
  if (!document.getElementById('fileSwitcher').contains(e.target)) {
    closeFileSwitcher();
  }
});

document.getElementById('backBtn').addEventListener('click', () => {
  if (state.dirty) {
    saveFile().then(() => window.location.href = '/');
  } else {
    window.location.href = '/';
  }
});

document.getElementById('commitBtn').addEventListener('click', () => saveAndCommit());
document.getElementById('printBtn').addEventListener('click', () => window.print());
document.getElementById('focusBtn').addEventListener('click', () => {
  state.focusMode = !state.focusMode;
  document.body.classList.toggle('focus-mode', state.focusMode);
  document.getElementById('focusBtn').classList.toggle('active', state.focusMode);
});

document.getElementById('themeToggleBtn').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(t);
  buildColorSettings();
});

document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('closeSettingsBtn').addEventListener('click', closeSettings);

document.getElementById('settingsPanel').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeSettings();
});

// Font settings
document.getElementById('settingFont').addEventListener('change', e => {
  document.documentElement.style.setProperty('--font-screen', e.target.value);
  localStorage.setItem('fw-font', e.target.value);
});

document.getElementById('settingFontSize').addEventListener('input', e => {
  const size = e.target.value + 'pt';
  document.documentElement.style.setProperty('--font-screen-size', size);
  document.getElementById('fontSizeLabel').textContent = size;
  localStorage.setItem('fw-font-size', size);
});

// Auto-commit toggle
document.getElementById('settingAutoCommit').addEventListener('change', e => {
  state.autoCommitEnabled = e.target.checked;
  if (state.autoCommitEnabled) startAutoCommit();
  else stopAutoCommit();
});

document.getElementById('settingCommitInterval').addEventListener('change', e => {
  state.autoCommitInterval = parseInt(e.target.value) * 60 * 1000;
  startAutoCommit();
});

// Remote URL presets
document.querySelectorAll('.remote-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const prefix = btn.dataset.prefix;
    const input = document.getElementById('remoteUrl');
    if (!input.value.startsWith('http')) input.value = prefix;
    else input.value = prefix;
    input.focus();
  });
});

document.getElementById('setRemoteBtn').addEventListener('click', async () => {
  const url = document.getElementById('remoteUrl').value.trim();
  if (!url) { toast('Please enter a remote URL', 'error'); return; }
  try {
    const res = await fetch(`${API}/projects/${encodeURIComponent(state.projectName)}/git/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (!res.ok) throw new Error((await res.json()).error);
    toast('Remote set successfully', 'success');
    loadGitStatus();
  } catch (err) { toast(err.message, 'error'); }
});

document.getElementById('pushBtn').addEventListener('click', async () => {
  const btn = document.getElementById('pushBtn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:12px;height:12px;border-width:1.5px"></div> Pushing…';
  try {
    await saveFile();
    await saveAndCommit('Pre-push checkpoint');
    const res = await fetch(`${API}/projects/${encodeURIComponent(state.projectName)}/git/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error((await res.json()).error);
    toast('Pushed to remote!', 'success');
    loadGitStatus();
  } catch (err) { toast('Push failed: ' + err.message, 'error'); }
  finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg> Push`;
  }
});

document.getElementById('exportFountainBtn').addEventListener('click', exportFountain);
document.getElementById('exportPdfBtn').addEventListener('click', () => window.print());

document.getElementById('themeToggleSettings').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(t);
  buildColorSettings();
});

// Notes toggle button
document.getElementById('toggleNotesBtn').addEventListener('click', toggleNotes);

// Global keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 'F11') {
    e.preventDefault();
    state.focusMode = !state.focusMode;
    document.body.classList.toggle('focus-mode', state.focusMode);
    document.getElementById('focusBtn').classList.toggle('active', state.focusMode);
  }
  // N toggles notes (only when not typing in an editable field)
  if (e.key === 'n' && !e.ctrlKey && !e.metaKey &&
      !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName) &&
      !document.activeElement?.isContentEditable) {
    toggleNotes();
  }
  if (e.key === 'Escape' && document.getElementById('settingsPanel').classList.contains('open')) {
    closeSettings();
  }
});

// ── Restore user preferences ──────────────────────────────────
function restorePreferences() {
  const font     = localStorage.getItem('fw-font');
  const fontSize = localStorage.getItem('fw-font-size');
  const theme    = localStorage.getItem('fw-theme') || 'dark';

  applyTheme(theme);

  if (localStorage.getItem('fw-notes-hidden') === '1') {
    document.body.classList.add('notes-hidden');
    const btn = document.getElementById('toggleNotesBtn');
    btn.title = 'Show notes (N)';
  } else {
    document.getElementById('toggleNotesBtn').classList.add('active');
  }

  if (font) {
    document.documentElement.style.setProperty('--font-screen', font);
    document.getElementById('settingFont').value = font;
  }
  if (fontSize) {
    document.documentElement.style.setProperty('--font-screen-size', fontSize);
    document.getElementById('settingFontSize').value = parseFloat(fontSize);
    document.getElementById('fontSizeLabel').textContent = fontSize;
  }
}

// ── Init ──────────────────────────────────────────────────────
restorePreferences();
initSidebarResize();
loadProject();
startAutoCommit();
