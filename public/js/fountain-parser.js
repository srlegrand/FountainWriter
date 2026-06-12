/**
 * Fountain screenplay format parser and serializer.
 * Spec: https://fountain.io/syntax
 */

const Fountain = (() => {

  const SCENE_HEADING_RE = /^(INT|EXT|EST|INT\.\/EXT|INT\/EXT|I\/E)[\s.]/i;
  const TRANSITION_RE = /^(FADE IN:|FADE OUT\.|FADE TO BLACK\.|CUT TO:|SMASH CUT TO:|MATCH CUT TO:|JUMP CUT TO:|WIPE TO:|TITLE CARD:|SUPER:)$|.+\sTO:$/;
  const CHARACTER_RE = /^[A-Z][A-Z\s0-9\-'\.]*(\s*\(.*\))?$/;
  const PARENTHETICAL_RE = /^\(.*\)$/;
  const TITLE_PAGE_KEY_RE = /^([A-Za-z\s]+):\s*(.*)/;

  function parseTitlePage(text) {
    const page = {};
    const lines = text.split('\n');
    let currentKey = null;
    let currentVal = [];

    for (const line of lines) {
      const match = line.match(TITLE_PAGE_KEY_RE);
      if (match) {
        if (currentKey) page[currentKey.toLowerCase().replace(/\s+/g, '_')] = currentVal.join('\n').trim();
        currentKey = match[1].trim();
        currentVal = match[2] ? [match[2].trim()] : [];
      } else if (currentKey && (line.startsWith('  ') || line.startsWith('\t'))) {
        currentVal.push(line.trim());
      }
    }
    if (currentKey) page[currentKey.toLowerCase().replace(/\s+/g, '_')] = currentVal.join('\n').trim();
    return page;
  }

  function isTitlePageLine(line) {
    return TITLE_PAGE_KEY_RE.test(line) || line.startsWith('  ') || line.startsWith('\t');
  }

  function parse(text) {
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    let titlePage = null;
    let bodyStart = 0;

    // Detect title page: if the first non-empty line matches "Key: Value", extract it
    const firstContentLine = text.trimStart();
    if (TITLE_PAGE_KEY_RE.test(firstContentLine.split('\n')[0])) {
      // Find where title page ends (double blank line or first non-title-page content)
      const lines = text.split('\n');
      let i = 0;
      let titleLines = [];
      while (i < lines.length) {
        const line = lines[i];
        if (i > 0 && line === '' && lines[i + 1] === '') {
          // Double blank line = end of title page
          bodyStart = titleLines.join('\n').length + 2;
          break;
        }
        if (i > 0 && line !== '' && !TITLE_PAGE_KEY_RE.test(line) &&
            !line.startsWith('  ') && !line.startsWith('\t')) {
          // Non-title line encountered
          bodyStart = titleLines.join('\n').length;
          break;
        }
        titleLines.push(line);
        i++;
      }
      if (titleLines.length > 0) {
        titlePage = parseTitlePage(titleLines.join('\n'));
        text = text.substring(text.indexOf('\n\n') + 2).trimStart();
      }
    }

    const blocks = [];
    // Split body into paragraphs by double newlines
    const rawParagraphs = text.split(/\n{2,}/);

    for (let pi = 0; pi < rawParagraphs.length; pi++) {
      const para = rawParagraphs[pi].trim();
      if (!para) continue;

      const lines = para.split('\n');
      const firstLine = lines[0];
      const trimmed = firstLine.trim();

      // Page break
      if (/^={3,}$/.test(trimmed)) {
        blocks.push({ type: 'page-break', text: '' });
        continue;
      }

      // Section heading
      if (/^#{1,6}\s/.test(trimmed)) {
        const level = trimmed.match(/^(#+)/)[1].length;
        blocks.push({ type: 'section', level, text: trimmed.replace(/^#+\s*/, '') });
        continue;
      }

      // Synopsis
      if (/^=\s/.test(trimmed)) {
        blocks.push({ type: 'synopsis', text: trimmed.replace(/^=\s*/, '') });
        continue;
      }

      // Centered text
      if (/^>.*<$/.test(trimmed)) {
        blocks.push({ type: 'centered', text: trimmed.slice(1, -1).trim() });
        continue;
      }

      // Forced scene heading
      if (trimmed.startsWith('.') && !trimmed.startsWith('..')) {
        blocks.push({ type: 'scene-heading', text: trimmed.slice(1).trim(), forced: true });
        // Any following lines in same para are action
        for (let j = 1; j < lines.length; j++) {
          if (lines[j].trim()) blocks.push({ type: 'action', text: lines[j].trim() });
        }
        continue;
      }

      // Auto scene heading
      if (lines.length >= 1 && SCENE_HEADING_RE.test(trimmed)) {
        blocks.push({ type: 'scene-heading', text: trimmed });
        for (let j = 1; j < lines.length; j++) {
          if (lines[j].trim()) blocks.push({ type: 'action', text: lines[j].trim() });
        }
        continue;
      }

      // Forced transition
      if (trimmed.startsWith('>') && !trimmed.endsWith('<')) {
        blocks.push({ type: 'transition', text: trimmed.slice(1).trim(), forced: true });
        continue;
      }

      // Auto transition
      if (lines.length === 1 && TRANSITION_RE.test(trimmed)) {
        blocks.push({ type: 'transition', text: trimmed });
        continue;
      }

      // Forced character (@)
      const forcedCharMatch = trimmed.match(/^@(.+)/);
      if (forcedCharMatch && lines.length >= 2) {
        const charText = forcedCharMatch[1].trim();
        blocks.push({ type: 'character', text: charText, forced: true });
        parseDialogueBlock(lines.slice(1), blocks);
        continue;
      }

      // Auto character (ALL CAPS, single line but paragraph has more lines)
      if (lines.length >= 2) {
        const charCandidate = trimmed.replace(/\s*\([^)]+\)\s*$/, '');
        if (CHARACTER_RE.test(charCandidate) && charCandidate === charCandidate.toUpperCase()) {
          const isDual = trimmed.endsWith('^');
          blocks.push({
            type: 'character',
            text: isDual ? trimmed.slice(0, -1).trim() : trimmed,
            dualDialogue: isDual
          });
          parseDialogueBlock(lines.slice(1), blocks);
          continue;
        }
      }

      // Lyric
      if (trimmed.startsWith('~')) {
        for (const line of lines) {
          if (line.trim()) blocks.push({ type: 'lyric', text: line.trim().replace(/^~\s*/, '') });
        }
        continue;
      }

      // Note
      if (/^\[\[.+\]\]$/.test(trimmed)) {
        blocks.push({ type: 'note', text: trimmed.slice(2, -2).trim() });
        continue;
      }

      // Default: action
      for (const line of lines) {
        if (line.trim()) {
          blocks.push({ type: 'action', text: line.trim() });
        }
      }
    }

    return { titlePage, blocks };
  }

  function parseDialogueBlock(lines, blocks) {
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (PARENTHETICAL_RE.test(t)) {
        blocks.push({ type: 'parenthetical', text: t });
      } else {
        blocks.push({ type: 'dialogue', text: t });
      }
    }
  }

  function serializeTitlePage(tp) {
    if (!tp) return '';
    const keyMap = {
      title: 'Title', credit: 'Credit', author: 'Author',
      source: 'Source', draft_date: 'Draft date', contact: 'Contact',
      copyright: 'Copyright', notes: 'Notes', revision: 'Revision'
    };
    let out = '';
    for (const [k, label] of Object.entries(keyMap)) {
      if (tp[k]) {
        const val = tp[k];
        if (val.includes('\n')) {
          out += `${label}:\n${val.split('\n').map(l => '    ' + l).join('\n')}\n`;
        } else {
          out += `${label}: ${val}\n`;
        }
      }
    }
    return out;
  }

  function serialize(titlePage, blocks) {
    let out = '';

    if (titlePage && Object.keys(titlePage).length > 0) {
      out += serializeTitlePage(titlePage) + '\n\n';
    }

    let prevType = null;

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const next = blocks[i + 1];
      if (!b.text && b.type !== 'page-break') { prevType = b.type; continue; }

      switch (b.type) {
        case 'scene-heading': {
          if (prevType !== null) out += '\n';
          const isAuto = SCENE_HEADING_RE.test(b.text);
          out += (isAuto ? '' : '.') + b.text.toUpperCase() + '\n';
          out += '\n';
          break;
        }
        case 'action': {
          if (prevType !== null && prevType !== 'scene-heading') out += '\n';
          out += b.text + '\n';
          if (!next || (next.type !== 'action')) out += '\n';
          break;
        }
        case 'character': {
          if (prevType !== null) out += '\n';
          const needsForce = !CHARACTER_RE.test(b.text) || b.forced;
          out += (needsForce && !CHARACTER_RE.test(b.text.toUpperCase()) ? '@' : '') +
                 b.text.toUpperCase() + (b.dualDialogue ? ' ^' : '') + '\n';
          break;
        }
        case 'dialogue': {
          out += b.text + '\n';
          if (!next || (next.type !== 'dialogue' && next.type !== 'parenthetical')) out += '\n';
          break;
        }
        case 'parenthetical': {
          out += b.text + '\n';
          break;
        }
        case 'transition': {
          if (prevType !== null) out += '\n';
          out += b.text + '\n';
          out += '\n';
          break;
        }
        case 'page-break': {
          out += '\n===\n\n';
          break;
        }
        case 'section': {
          out += '#'.repeat(b.level || 1) + ' ' + b.text + '\n\n';
          break;
        }
        case 'synopsis': {
          out += '= ' + b.text + '\n\n';
          break;
        }
        case 'centered': {
          out += '>' + b.text + '<\n\n';
          break;
        }
        case 'lyric': {
          out += '~' + b.text + '\n';
          if (!next || next.type !== 'lyric') out += '\n';
          break;
        }
        case 'note': {
          out += '[[' + b.text + ']]\n\n';
          break;
        }
      }

      prevType = b.type;
    }

    return out.trimEnd() + '\n';
  }

  // Extract all character names from parsed blocks
  function extractCharacters(blocks) {
    const chars = new Set();
    for (const b of blocks) {
      if (b.type === 'character' && b.text) {
        chars.add(b.text.trim().replace(/\s*\(.*\)$/, '').toUpperCase());
      }
    }
    return [...chars].sort();
  }

  // Extract all scene headings
  function extractSceneHeadings(blocks) {
    return blocks
      .filter(b => b.type === 'scene-heading' && b.text)
      .map(b => b.text.toUpperCase())
      .filter((v, i, a) => a.indexOf(v) === i);
  }

  // Count pages (approximate)
  function estimatePages(blocks) {
    let lineCount = 0;
    for (const b of blocks) {
      if (!b.text) continue;
      switch (b.type) {
        case 'scene-heading': lineCount += 3; break;
        case 'action': lineCount += Math.ceil(b.text.length / 60) + 1; break;
        case 'character': lineCount += 1; break;
        case 'dialogue': lineCount += Math.ceil(b.text.length / 35) + 1; break;
        case 'parenthetical': lineCount += 1; break;
        case 'transition': lineCount += 2; break;
        default: lineCount += 1;
      }
    }
    return Math.max(1, Math.round(lineCount / 55));
  }

  // Count words
  function countWords(blocks) {
    return blocks
      .filter(b => ['action', 'dialogue', 'character', 'scene-heading'].includes(b.type))
      .reduce((acc, b) => acc + (b.text || '').trim().split(/\s+/).filter(Boolean).length, 0);
  }

  // Inline formatting: convert fountain markup to HTML spans
  function inlineToHTML(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/_(.+?)_/g, '<u>$1</u>')
      .replace(/\[\[(.+?)\]\]/g, '<span class="note-inline">[[<em>$1</em>]]</span>');
  }

  return { parse, serialize, serializeTitlePage, parseTitlePage, extractCharacters, extractSceneHeadings, estimatePages, countWords, inlineToHTML };

})();

// CommonJS export for Node, global for browser
if (typeof module !== 'undefined') module.exports = Fountain;
