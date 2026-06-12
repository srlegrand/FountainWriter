'use strict';

const API = '/api';
let pendingDelete = null;
let importedContent = null; // holds raw text of an imported .fountain file

// ── Import handling ───────────────────────────────────────────
function parseTitlePageFields(text) {
  const fields = {};
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Za-z][A-Za-z\s]*):\s*(.+)/);
    if (!m) {
      // Blank line after title page block means body starts
      if (line.trim() === '' && Object.keys(fields).length > 0) break;
      continue;
    }
    const key = m[1].trim().toLowerCase().replace(/\s+/g, '_');
    fields[key] = m[2].trim().replace(/[_*]/g, ''); // strip fountain emphasis
  }
  return fields;
}

function applyImportedFile(fileName, content) {
  importedContent = content;

  // Parse title page fields and pre-fill the form
  const fields = parseTitlePageFields(content);

  const titleEl  = document.getElementById('scriptTitle');
  const authorEl = document.getElementById('scriptAuthor');
  const sourceEl = document.getElementById('scriptSource');
  const creditEl = document.getElementById('scriptCredit');
  const nameEl   = document.getElementById('projectName');

  if (fields.title)  titleEl.value  = fields.title;
  if (fields.author) authorEl.value = fields.author;
  if (fields.source) sourceEl.value = fields.source;
  if (fields.credit) {
    // Try to match existing option
    const opts = [...creditEl.options];
    const match = opts.find(o => o.value.toLowerCase().includes(fields.credit.toLowerCase()));
    if (match) creditEl.value = match.value;
  }

  // Auto-set project ID from title if not manually edited
  if (!nameEl._manuallyEdited && fields.title) {
    nameEl.value = fields.title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .substring(0, 40);
  }

  // Show banner, hide drop zone
  document.getElementById('importDropZone').style.display = 'none';
  const banner = document.getElementById('importedFileBanner');
  banner.style.display = 'flex';
  document.getElementById('importedFileName').textContent = fileName;

  updatePreview();
}

function clearImport() {
  importedContent = null;
  document.getElementById('importFileInput').value = '';
  document.getElementById('importDropZone').style.display = 'flex';
  document.getElementById('importedFileBanner').style.display = 'none';
}

function setupImportHandlers() {
  const dropZone  = document.getElementById('importDropZone');
  const fileInput = document.getElementById('importFileInput');

  document.getElementById('importBrowseBtn').addEventListener('click', e => {
    e.stopPropagation();
    fileInput.click();
  });

  dropZone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => applyImportedFile(file.name, e.target.result);
    reader.readAsText(file);
  });

  // Drag & drop
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file || !file.name.endsWith('.fountain')) {
      toast('Please drop a .fountain file', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = ev => applyImportedFile(file.name, ev.target.result);
    reader.readAsText(file);
  });

  document.getElementById('clearImportBtn').addEventListener('click', e => {
    e.stopPropagation();
    clearImport();
  });
}


// ── Utilities ─────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function timeAgo(dateStr) {
  if (!dateStr) return 'Never';
  const d = new Date(dateStr);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff/86400)}d ago`;
  return d.toLocaleDateString();
}

// ── Theme ─────────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('fw-theme', t);
  document.getElementById('themeIcon').textContent = t === 'dark' ? '☀️' : '🌙';
  document.getElementById('themeLabel').textContent = t === 'dark' ? 'Light' : 'Dark';
}

document.getElementById('themeToggle').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme;
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ── Project card rendering ─────────────────────────────────────
function renderProject(p) {
  const card = document.createElement('div');
  card.className = 'project-card';
  card.dataset.name = p.name;

  const gitClean = p.git?.clean;
  const dotClass = gitClean === false ? 'git-dot dirty' : 'git-dot';
  const dotTitle = gitClean === false ? 'Uncommitted changes' : 'Clean';

  card.innerHTML = `
    <div class="project-card-menu">
      <button title="Delete project" data-delete="${p.name}">✕</button>
    </div>
    <div class="project-card-cover">
      <div class="script-title">${escapeHtml(p.title || p.name)}</div>
      ${p.author ? `<div class="script-author">by ${escapeHtml(p.author)}</div>` : ''}
    </div>
    <div class="project-card-body">
      <div class="project-card-name">${escapeHtml(p.name)}</div>
      <div class="project-card-meta">
        <span class="pages">${p.pageCount} page${p.pageCount !== 1 ? 's' : ''}${p.fileCount > 1 ? ` · ${p.fileCount} screenplays` : ''}</span>
        ${p.git !== null ? `<div class="${dotClass}" title="${dotTitle}"></div>` : ''}
      </div>
    </div>
    <div class="project-card-footer">${timeAgo(p.lastModified)}</div>
  `;

  card.querySelector('[data-delete]').addEventListener('click', e => {
    e.stopPropagation();
    openDeleteModal(p.name);
  });

  card.addEventListener('click', () => {
    window.location.href = `/editor/${p.name}`;
  });

  return card;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function renderNewCard() {
  const card = document.createElement('div');
  card.className = 'project-card project-card-new';
  card.innerHTML = `
    <div class="plus-icon">+</div>
    <span>New Screenplay</span>
  `;
  card.addEventListener('click', openNewProjectModal);
  return card;
}

// ── Load & render projects ─────────────────────────────────────
async function loadProjects() {
  try {
    const res = await fetch(`${API}/projects`);
    if (!res.ok) throw new Error('Failed to load projects');
    const projects = await res.json();

    const grid = document.getElementById('projectsGrid');
    const count = document.getElementById('projectCount');
    grid.innerHTML = '';

    grid.appendChild(renderNewCard());

    for (const p of projects) {
      grid.appendChild(renderProject(p));
    }

    if (projects.length === 0) {
      count.textContent = 'No projects yet — start writing!';
    } else {
      count.textContent = `${projects.length} project${projects.length !== 1 ? 's' : ''}`;
    }
  } catch (err) {
    toast('Could not load projects: ' + err.message, 'error');
    document.getElementById('projectCount').textContent = 'Error loading projects';
  } finally {
    const overlay = document.getElementById('loadingOverlay');
    overlay.classList.add('hidden');
    setTimeout(() => overlay.remove(), 400);
  }
}

// ── New Project Modal ─────────────────────────────────────────
function openNewProjectModal() {
  document.getElementById('newProjectModal').classList.add('open');
  document.getElementById('projectName').focus();
  updatePreview();
}

function closeNewProjectModal() {
  document.getElementById('newProjectModal').classList.remove('open');
  clearForm();
}

function clearForm() {
  ['projectName','scriptTitle','scriptAuthor','scriptSource','scriptContact'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
    if (el) el._manuallyEdited = false;
  });
  document.getElementById('scriptCredit').selectedIndex = 0;
  clearImport();
  updatePreview();
}

function updatePreview() {
  const title  = document.getElementById('scriptTitle').value.trim() || 'Untitled';
  const credit = document.getElementById('scriptCredit').value;
  const author = document.getElementById('scriptAuthor').value.trim() || '—';
  const source = document.getElementById('scriptSource').value.trim();

  document.getElementById('previewTitle').textContent = title;
  document.getElementById('previewCredit').textContent = credit;
  document.getElementById('previewAuthor').textContent = author;

  const sourceEl = document.getElementById('previewSource');
  if (source) {
    sourceEl.textContent = source;
    sourceEl.style.display = '';
  } else {
    sourceEl.style.display = 'none';
  }
}

// Auto-fill project ID from title
document.getElementById('scriptTitle').addEventListener('input', () => {
  const title = document.getElementById('scriptTitle').value;
  const nameField = document.getElementById('projectName');
  if (!nameField._manuallyEdited) {
    nameField.value = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .substring(0, 40);
  }
  updatePreview();
});

document.getElementById('projectName').addEventListener('input', () => {
  document.getElementById('projectName')._manuallyEdited = true;
});

['scriptAuthor','scriptCredit','scriptSource','scriptContact'].forEach(id => {
  document.getElementById(id).addEventListener('input', updatePreview);
  document.getElementById(id).addEventListener('change', updatePreview);
});

async function createProject() {
  const name    = document.getElementById('projectName').value.trim();
  const title   = document.getElementById('scriptTitle').value.trim();
  const author  = document.getElementById('scriptAuthor').value.trim();
  const credit  = document.getElementById('scriptCredit').value;
  const source  = document.getElementById('scriptSource').value.trim();
  const contact = document.getElementById('scriptContact').value.trim();

  if (!name) { toast('Please enter a project ID', 'error'); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    toast('Project ID can only contain letters, numbers, hyphens, and underscores', 'error');
    return;
  }

  const btn = document.getElementById('createProjectBtn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Creating…';

  try {
    const body = { name, title, author, credit, source, contact };
    if (importedContent) body.content = importedContent;

    const res = await fetch(`${API}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create project');

    closeNewProjectModal();
    toast(`"${title || name}" created!`, 'success');
    await new Promise(r => setTimeout(r, 400));
    window.location.href = `/editor/${name}`;
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Create Project`;
  }
}

// ── Delete Modal ──────────────────────────────────────────────
function openDeleteModal(name) {
  pendingDelete = name;
  document.getElementById('deleteProjectName').textContent = name;
  document.getElementById('deleteModal').classList.add('open');
}

function closeDeleteModal() {
  pendingDelete = null;
  document.getElementById('deleteModal').classList.remove('open');
}

async function deleteProject() {
  if (!pendingDelete) return;
  const name = pendingDelete;
  closeDeleteModal();

  try {
    const res = await fetch(`${API}/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    toast(`"${name}" deleted`, 'info');
    loadProjects();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Event Listeners ───────────────────────────────────────────
document.getElementById('newProjectBtn').addEventListener('click', openNewProjectModal);
document.getElementById('closeModalBtn').addEventListener('click', closeNewProjectModal);
document.getElementById('cancelModalBtn').addEventListener('click', closeNewProjectModal);
document.getElementById('createProjectBtn').addEventListener('click', createProject);
document.getElementById('cancelDeleteBtn').addEventListener('click', closeDeleteModal);
document.getElementById('confirmDeleteBtn').addEventListener('click', deleteProject);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeNewProjectModal();
    closeDeleteModal();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (document.getElementById('newProjectModal').classList.contains('open')) createProject();
  }
});

// Close modal on backdrop click
document.getElementById('newProjectModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeNewProjectModal();
});
document.getElementById('deleteModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeDeleteModal();
});

// ── Init ──────────────────────────────────────────────────────
const savedTheme = localStorage.getItem('fw-theme') || 'dark';
applyTheme(savedTheme);
setupImportHandlers();
loadProjects();
