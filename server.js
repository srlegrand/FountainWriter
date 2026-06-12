const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const simpleGit = require('simple-git');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3737;
const PROJECTS_DIR = path.join(os.homedir(), 'FountainProjects');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function ensureDir(dir) {
  try { await fs.mkdir(dir, { recursive: true }); } catch {}
}

function estimatePageCount(content) {
  const lines = content.split('\n').filter(l => l.trim()).length;
  return Math.max(1, Math.round(lines / 55));
}

function generateTitlePage({ title, author, credit, source, draftDate, contact }) {
  let page = `Title: ${title || 'Untitled'}\n`;
  if (credit) page += `Credit: ${credit}\n`;
  page += `Author: ${author || 'Unknown'}\n`;
  if (source) page += `Source: ${source}\n`;
  page += `Draft date: ${draftDate || new Date().toLocaleDateString('en-US')}\n`;
  if (contact) page += `Contact: ${contact}\n`;
  return page;
}

function extractTitle(content) {
  const match = content.match(/^Title:\s*(.+)/im);
  if (!match) return null;
  return match[1].trim().replace(/[*_]/g, '');
}

function extractAuthor(content) {
  const match = content.match(/^Author:\s*(.+)/im);
  return match ? match[1].trim() : null;
}

// GET all projects
app.get('/api/projects', async (req, res) => {
  try {
    await ensureDir(PROJECTS_DIR);
    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    const projects = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectPath = path.join(PROJECTS_DIR, entry.name);
      try {
        const files = await fs.readdir(projectPath);
        const fountainFiles = files.filter(f => f.endsWith('.fountain'));
        if (fountainFiles.length === 0) continue;

        const mainFile = fountainFiles.find(f => f === `${entry.name}.fountain`) || fountainFiles[0];
        const filePath = path.join(projectPath, mainFile);
        const stat = await fs.stat(filePath);
        const content = await fs.readFile(filePath, 'utf-8');

        let gitStatus = null;
        try {
          const git = simpleGit(projectPath);
          const status = await git.status();
          gitStatus = { clean: status.isClean() };
          const log = await git.log({ maxCount: 1 });
          if (log.latest) gitStatus.lastCommit = log.latest.date;
        } catch {}

        projects.push({
          name: entry.name,
          title: extractTitle(content) || entry.name,
          author: extractAuthor(content),
          mainFile,
          fileCount: fountainFiles.length,
          lastModified: stat.mtime,
          pageCount: estimatePageCount(content),
          git: gitStatus
        });
      } catch {}
    }

    projects.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create project
app.post('/api/projects', async (req, res) => {
  try {
    const { name, title, author, credit, source, contact } = req.body;
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      return res.status(400).json({ error: 'Invalid project name. Use letters, numbers, hyphens, underscores.' });
    }

    const projectPath = path.join(PROJECTS_DIR, name);

    // Check if exists
    try {
      await fs.access(projectPath);
      return res.status(409).json({ error: 'A project with this name already exists.' });
    } catch {}

    await fs.mkdir(projectPath, { recursive: true });

    let fountainContent;
    if (req.body.content) {
      // Use imported content as-is
      fountainContent = req.body.content;
    } else {
      const titlePageContent = generateTitlePage({ title, author, credit: credit || 'Written by', source, contact });
      fountainContent = titlePageContent + '\n\n\n';
    }
    const fileName = `${name}.fountain`;
    await fs.writeFile(path.join(projectPath, fileName), fountainContent, 'utf-8');

    // Initialize git
    const git = simpleGit(projectPath);
    await git.init();
    try {
      await git.addConfig('user.email', 'fountainwriter@local');
      await git.addConfig('user.name', 'FountainWriter');
    } catch {}
    await git.add('.');
    await git.commit(`Initial commit: ${title || name}`);

    res.json({ success: true, name, title: title || name, mainFile: fileName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE project
app.delete('/api/projects/:name', async (req, res) => {
  try {
    const projectPath = path.join(PROJECTS_DIR, req.params.name);
    await fs.rm(projectPath, { recursive: true, force: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET list of all fountain files in project
app.get('/api/projects/:name/files', async (req, res) => {
  try {
    const projectPath = path.join(PROJECTS_DIR, req.params.name);
    const entries = await fs.readdir(projectPath);
    const fountainFiles = entries.filter(f => f.endsWith('.fountain'));

    const infos = await Promise.all(fountainFiles.map(async f => {
      const stat = await fs.stat(path.join(projectPath, f));
      const content = await fs.readFile(path.join(projectPath, f), 'utf-8');
      return {
        fileName: f,
        title: extractTitle(content) || f.replace('.fountain', ''),
        author: extractAuthor(content),
        lastModified: stat.mtime,
        pageCount: estimatePageCount(content)
      };
    }));

    infos.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    res.json(infos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add a new fountain file to project (new screenplay or import)
app.post('/api/projects/:name/files', async (req, res) => {
  try {
    const { content, fileName: requestedName, title, author, credit, source, contact } = req.body;
    const projectPath = path.join(PROJECTS_DIR, req.params.name);

    // Derive a safe filename
    let baseName = requestedName
      ? requestedName.replace(/\.fountain$/, '')
      : (title || 'untitled').toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').substring(0, 40);
    baseName = baseName || 'untitled';

    // Avoid collisions
    const existing = await fs.readdir(projectPath);
    let finalName = `${baseName}.fountain`;
    let counter = 1;
    while (existing.includes(finalName)) {
      finalName = `${baseName}-${counter}.fountain`;
      counter++;
    }

    const fileContent = content ||
      (generateTitlePage({ title, author, credit: credit || 'Written by', source, contact }) + '\n\n\n');

    await fs.writeFile(path.join(projectPath, finalName), fileContent, 'utf-8');

    const git = simpleGit(projectPath);
    await git.add('.');
    await git.commit(`Add screenplay: ${finalName}`);

    res.json({ success: true, fileName: finalName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET notes for a file
app.get('/api/projects/:name/notes', async (req, res) => {
  try {
    const { file } = req.query;
    if (!file) return res.json([]);
    const notesPath = path.join(PROJECTS_DIR, req.params.name, file.replace('.fountain', '.notes.json'));
    try {
      const raw = await fs.readFile(notesPath, 'utf-8');
      res.json(JSON.parse(raw));
    } catch { res.json([]); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT notes for a file
app.put('/api/projects/:name/notes', async (req, res) => {
  try {
    const { file } = req.query;
    if (!file) return res.status(400).json({ error: 'file required' });
    const notesPath = path.join(PROJECTS_DIR, req.params.name, file.replace('.fountain', '.notes.json'));
    await fs.writeFile(notesPath, JSON.stringify(req.body, null, 2), 'utf-8');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET file content
app.get('/api/projects/:name/content', async (req, res) => {
  try {
    const projectPath = path.join(PROJECTS_DIR, req.params.name);
    const allEntries = await fs.readdir(projectPath);
    const fountainFiles = allEntries.filter(f => f.endsWith('.fountain'));
    if (!fountainFiles.length) return res.status(404).json({ error: 'No fountain file found' });

    // Honour explicit ?file= param, else fall back to project-named file then first
    let targetFile = req.query.file;
    if (!targetFile || !fountainFiles.includes(targetFile)) {
      targetFile = fountainFiles.find(f => f === `${req.params.name}.fountain`) || fountainFiles[0];
    }

    const content = await fs.readFile(path.join(projectPath, targetFile), 'utf-8');
    res.json({ content, fileName: targetFile, allFiles: fountainFiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT save file content
app.put('/api/projects/:name/content', async (req, res) => {
  try {
    const { content, fileName } = req.body;
    const filePath = path.join(PROJECTS_DIR, req.params.name, fileName);
    await fs.writeFile(filePath, content, 'utf-8');
    res.json({ success: true, savedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST git commit
app.post('/api/projects/:name/git/commit', async (req, res) => {
  try {
    const projectPath = path.join(PROJECTS_DIR, req.params.name);
    const git = simpleGit(projectPath);
    const status = await git.status();
    if (status.files.length === 0) {
      return res.json({ success: true, message: 'Nothing to commit' });
    }
    const message = req.body.message || `Auto-backup: ${new Date().toLocaleString()}`;
    await git.add('.');
    const result = await git.commit(message);
    res.json({ success: true, commit: result.commit, message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET git status + log
app.get('/api/projects/:name/git/status', async (req, res) => {
  try {
    const projectPath = path.join(PROJECTS_DIR, req.params.name);
    const git = simpleGit(projectPath);
    const status = await git.status();
    const log = await git.log({ maxCount: 20 });
    const remotes = await git.getRemotes(true);
    res.json({
      clean: status.isClean(),
      modified: status.modified,
      log: log.all,
      remotes
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST set remote
app.post('/api/projects/:name/git/remote', async (req, res) => {
  try {
    const { url, remoteName = 'origin' } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const projectPath = path.join(PROJECTS_DIR, req.params.name);
    const git = simpleGit(projectPath);
    const remotes = await git.getRemotes();
    if (remotes.find(r => r.name === remoteName)) {
      await git.removeRemote(remoteName);
    }
    await git.addRemote(remoteName, url);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST push to remote
app.post('/api/projects/:name/git/push', async (req, res) => {
  try {
    const projectPath = path.join(PROJECTS_DIR, req.params.name);
    const git = simpleGit(projectPath);
    const result = await git.push(['--set-upstream', 'origin', 'main']);
    res.json({ success: true });
  } catch (err) {
    // Try master branch if main fails
    try {
      const git = simpleGit(path.join(PROJECTS_DIR, req.params.name));
      await git.push(['--set-upstream', 'origin', 'master']);
      res.json({ success: true });
    } catch (err2) {
      res.status(500).json({ error: err.message });
    }
  }
});

// GET git log
app.get('/api/projects/:name/git/log', async (req, res) => {
  try {
    const projectPath = path.join(PROJECTS_DIR, req.params.name);
    const git = simpleGit(projectPath);
    const log = await git.log({ maxCount: 50 });
    res.json(log.all);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET file + notes at a specific git commit
app.get('/api/projects/:name/git/file', async (req, res) => {
  try {
    const { commit, file } = req.query;
    if (!commit || !file) return res.status(400).json({ error: 'commit and file required' });
    const projectPath = path.join(PROJECTS_DIR, req.params.name);
    const git = simpleGit(projectPath);
    const content = await git.show([`${commit}:${file}`]);
    let notes = [];
    try {
      const nf = file.replace('.fountain', '.notes.json');
      const raw = await git.show([`${commit}:${nf}`]);
      notes = JSON.parse(raw);
    } catch {}
    res.json({ content, notes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE a fountain file from a project
app.delete('/api/projects/:name/files', async (req, res) => {
  try {
    const { file } = req.query;
    if (!file || !file.endsWith('.fountain')) return res.status(400).json({ error: 'invalid file' });
    const projectPath = path.join(PROJECTS_DIR, req.params.name);
    const filePath = path.join(projectPath, file);
    const notesPath = filePath.replace('.fountain', '.notes.json');
    await fs.unlink(filePath).catch(() => {});
    await fs.unlink(notesPath).catch(() => {});
    const git = simpleGit(projectPath);
    await git.add('.').catch(() => {});
    await git.commit(`Deleted ${file}`).catch(() => {});
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET git graph (all branches, topo order, with parent hashes)
app.get('/api/projects/:name/git/graph', async (req, res) => {
  try {
    const projectPath = path.join(PROJECTS_DIR, req.params.name);
    const git = simpleGit(projectPath);
    const raw = await git.raw([
      'log', '--all', '--topo-order',
      '--format=COMMIT:%H|%P|%s|%ai|%D'
    ]);
    const commits = raw.split('\n')
      .filter(l => l.startsWith('COMMIT:'))
      .map(l => {
        const parts = l.slice(7).split('|');
        // format: hash | parents (space-sep) | subject | author-date | ref-names
        const hash = parts[0] || '';
        const parentsRaw = parts[1] || '';
        const parents = parentsRaw.trim() ? parentsRaw.trim().split(' ').filter(p => p.length > 0) : [];
        return {
          hash,
          parents,
          message: parts[2] || '',
          date: parts[3] || '',
          refs: parts[4] ? parts[4].split(',').map(r => r.trim()).filter(Boolean) : []
        };
      });
    res.json(commits);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET local branches
app.get('/api/projects/:name/git/branches', async (req, res) => {
  try {
    const projectPath = path.join(PROJECTS_DIR, req.params.name);
    const git = simpleGit(projectPath);
    const summary = await git.branchLocal();
    res.json({ current: summary.current, branches: Object.keys(summary.branches) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create branch
app.post('/api/projects/:name/git/branch', async (req, res) => {
  try {
    const { name, from } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const projectPath = path.join(PROJECTS_DIR, req.params.name);
    const git = simpleGit(projectPath);
    if (from) {
      await git.raw(['checkout', '-b', name, from]);
    } else {
      await git.checkoutLocalBranch(name);
    }
    res.json({ ok: true, name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST checkout branch
app.post('/api/projects/:name/git/checkout', async (req, res) => {
  try {
    const { branch } = req.body;
    if (!branch) return res.status(400).json({ error: 'branch required' });
    const projectPath = path.join(PROJECTS_DIR, req.params.name);
    const git = simpleGit(projectPath);
    await git.checkout(branch);
    const files = await fs.readdir(projectPath);
    const fountainFiles = files.filter(f => f.endsWith('.fountain'));
    res.json({ ok: true, branch, files: fountainFiles });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST merge branch into current
app.post('/api/projects/:name/git/merge', async (req, res) => {
  try {
    const { branch, deleteAfter } = req.body;
    if (!branch) return res.status(400).json({ error: 'branch required' });
    const projectPath = path.join(PROJECTS_DIR, req.params.name);
    const git = simpleGit(projectPath);
    await git.merge([branch]);
    if (deleteAfter) await git.deleteLocalBranch(branch, true);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Serve editor for project
app.get('/editor/:name', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'editor.html'));
});

// Start
ensureDir(PROJECTS_DIR).then(() => {
  app.listen(PORT, () => {
    console.log(`\n  FountainWriter is running at http://localhost:${PORT}\n`);
  });
});
