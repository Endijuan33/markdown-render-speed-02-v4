// A fresh, document-local scanner. Block output is linear; only inline text
// waits for the document's forward reference definitions.
const blockNames = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul'.split(' '));
const punctuation = /[\p{P}\p{S}]/u;
const whitespace = /\s/u;
const escapeChars = /[&<>"']/;
const entity = /^&(?:#\d+|#x[\da-f]+|[a-z][\da-z]*);/i;
const plainBoundary = /[\\<!\[`*_~\n]| {2,}(?=\n)|(?:https?:\/\/|ftp:\/\/|www\.|(?:mailto|xmpp):)|(?<![a-z\d._+\-])[a-z\d._+\-]+@[a-z\d_-]+\.[a-z\d_-]/gi;
const literalBoundary = /[\\<!\[`*_~\n]| {2,}(?=\n)/g;
const urlBoundary = /[\\<!\[`*_~\n]| {2,}(?=\n)|https?:\/\/|ftp:\/\/|www\.|mailto:|xmpp:/gi;
const maskLiteral = /[\\`]/g;
const maskSyntax = /[\[`<]/g;
const simpleInline = /[\\<!\[`*_~\n@]/;
const urlHint = /https?:|ftp:|www\.|mailto:|xmpp:/i;
const zeroIndent = { width: 0, length: 0 };

function escapeText(s, all = false) {
  if (!escapeChars.test(s)) return s;
  return s.replace(all ? /[&<>"']/g : /&(?!(?:#\d{1,7}|#x[\da-f]{1,6}|\w+);)|[<>"']/gi,
    c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
}

function unescapePunctuation(s) {
  return s.indexOf('\\') < 0 ? s : s.replace(/\\([\p{P}\p{S}])/gu, '$1');
}

function plainText(s) {
  if (s.includes('&#')) s = s.replace(/&#(?:\d{1,7}|[xX][\da-fA-F]{1,6});/g, raw => {
    const hex = raw[2] === 'x' || raw[2] === 'X';
    const n = Number.parseInt(raw.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return n === 38 ? '&amp;' : n === 0 || n > 0x10ffff || n >= 0xd800 && n <= 0xdfff ? '\ufffd' : String.fromCodePoint(n);
  });
  return escapeText(s);
}

function referenceKey(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().replace(/ß/g, 'ss');
}

function destination(s) {
  try { return escapeText(encodeURI(s).replace(/%25/g, '%')); }
  catch { return null; }
}

function leading(line, column = 0) {
  if (line[0] !== ' ' && line[0] !== '\t') return zeroIndent;
  let i = 0, width = column;
  while (i < line.length) {
    if (line[i] === ' ') width++;
    else if (line[i] === '\t') width += 4 - width % 4;
    else break;
    i++;
  }
  return { width: width - column, length: i };
}

function expandLeading(line, column = 0) {
  const n = leading(line, column);
  return line.slice(0, n.length).includes('\t') ? ' '.repeat(n.width) + line.slice(n.length) : line;
}

function isBlank(line) { return !line || (line[0] === ' ' || line[0] === '\t') && /^[ \t]*$/.test(line); }
function fenceStart(line) {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  return m && (m[1][0] !== '`' || !m[2].includes('`')) ? m : null;
}
function headingStart(line) { return /^ {0,3}(#{1,6})(?:\s|$)/.test(line); }
function thematic(line) {
  const s = line.replace(/^ {0,3}/, '');
  return /^(?:\*[ \t]*){3,}$/.test(s) || /^(?:-[ \t]*){3,}$/.test(s) || /^(?:_[ \t]*){3,}$/.test(s);
}
function listMarker(line) {
  const m = /^( {0,3})([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*)|$)/.exec(line);
  if (!m) return null;
  return { indent: m[1].length, marker: m[2], space: m[3] || '', content: m[4] || '', width: m[1].length + m[2].length };
}

function htmlStart(line, interrupt = false) {
  const s = line.replace(/^ {0,3}/, '');
  if (s[0] !== '<') return null;
  const raw = /^<(script|pre|style|textarea)(?:\s|>|$)/i.exec(s);
  if (raw) return { end: new RegExp('</' + raw[1] + '>', 'i') };
  if (s.startsWith('<!--')) return { end: /-->/, comment: true };
  if (s.startsWith('<?')) return { end: /\?>/ };
  if (s.startsWith('<![CDATA[')) return { end: /\]\]>/ };
  if (/^<![A-Z]/i.test(s)) return { end: />/ };
  const tag = /^<\/?([a-z][a-z\d-]*)(?=[ \t\n/>]|$)/i.exec(s);
  if (tag && blockNames.has(tag[1].toLowerCase())) return { blank: true };
  if (!interrupt && /^(?:<\/[a-z][a-z\d-]*\s*>|<[a-z][a-z\d-]*(?: +[a-zA-Z_:][\w.:-]*(?: *= *(?:"[^"\n]*"|'[^'\n]*'|[^\s"'=<>`]+))?)* *\/?>)[ \t]*$/i.test(s)) return { blank: true };
  return null;
}

function tableCells(line) {
  let s = line.trim(), cells = [], start = 0;
  if (s[0] === '|') { s = s.slice(1); }
  let last = s.length - 1, escapes = 0;
  for (let i = last - 1; i >= 0 && s[i] === '\\'; i--) escapes++;
  if (s[last] === '|' && escapes % 2 === 0) s = s.slice(0, -1);
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '|') continue;
    let n = 0;
    for (let j = i - 1; j >= start && s[j] === '\\'; j--) n++;
    if (n % 2) continue;
    cells.push(s.slice(start, i).trim().replace(/\\\|/g, '|'));
    start = i + 1;
  }
  cells.push(s.slice(start).trim().replace(/\\\|/g, '|'));
  return cells;
}

function tableInfo(rows, i) {
  if (i + 1 >= rows.length || !/^[ |:\-]+$/.test(rows[i + 1]) || !rows[i + 1].includes('-')) return null;
  const indent = leading(rows[i + 1]);
  if (indent.width > 3 || rows[i + 1].includes('\t')) return null;
  const d = tableCells(rows[i + 1]);
  if (!d.every(c => /^:?-+:?$/.test(c))) return null;
  const head = tableCells(rows[i]);
  if (head.length !== d.length || (!rows[i].includes('|') && !rows[i + 1].includes('|'))) return null;
  return { head, align: d.map(c => c[0] === ':' ? c.endsWith(':') ? 'center' : 'left' : c.endsWith(':') ? 'right' : '') };
}

function tableRowContinues(line) {
  if (!line || /^ *$/.test(line) || /^(?: {4}| {0,3}\t)./.test(line)) return false;
  if (thematic(line) || headingStart(line) || fenceStart(line) || /^ {0,3}>/.test(line) || htmlStart(line, true)) return false;
  const mark = listMarker(line);
  return !mark || !(mark.marker.length === 1 || /^1[.)]$/.test(mark.marker));
}

function interrupt(rows, i, allLists = false, tables = true) {
  const line = rows[i];
  if (isBlank(line)) return true;
  const ind = leading(line), char = line[ind.length];
  if (ind.width < 4 && (
    (char === '-' || char === '*' || char === '_') && thematic(line) ||
    char === '#' && headingStart(line) ||
    (char === '`' || char === '~') && fenceStart(line) ||
    char === '>' || char === '<' && htmlStart(line, true))) return true;
  const mark = (char === '-' || char === '+' || char === '*' || char >= '0' && char <= '9') ? listMarker(line) : null;
  if (mark && (allLists || (mark.content && (mark.marker.length === 1 || /^1[.)]$/.test(mark.marker))))) return true;
  return tables && !!tableInfo(rows, i);
}

function readDefinition(rows, at, refs) {
  if (!/^ {0,3}\[/.test(rows[at])) return 0;
  // Definitions span at most one nonblank label and an optional title line.
  let stop = at;
  while (stop < rows.length && stop < at + 12 && !isBlank(rows[stop])) stop++;
  const s = rows.slice(at, stop).join('\n');
  const m = /^ {0,3}\[((?:\\[\s\S]|[^\[\]\\])+?)\]: *(?:\n[ \t]*)?(<[^\n]*?>|[^\s<]+)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^()\\])*\)))?[ \t]*(?=\n|$)/.exec(s);
  if (!m || !m[1].trim()) return 0;
  const key = referenceKey(m[1]);
  if (!refs.has(key)) refs.set(key, { href: unescapePunctuation(m[2][0] === '<' ? m[2].slice(1, -1) : m[2]), title: m[3] ? unescapePunctuation(m[3].slice(1, -1)) : '' });
  return m[0].split('\n').length;
}

function blockScan(source, refs, wrap = true, continuations = null, listBoundaries = null) {
  const rows = source.split('\n'), parts = [], paragraphs = [];
  let i = 0, blankBetween = false, previous = null, lastKind = '';
  const inlinePart = (text, paragraph = false) => {
    const p = { text, paragraph, wrap };
    parts.push(p); if (paragraph) paragraphs.push(p); previous = p; lastKind = paragraph ? 'paragraph' : 'inline';
  };
  while (i < rows.length) {
    let line = rows[i];
    if (isBlank(line)) {
      let start = i;
      while (i < rows.length && isBlank(rows[i])) i++;
      if (start > 0 && i < rows.length) blankBetween = true;
      previous = null;
      continue;
    }
    const ind = leading(line);
    const blockChar = line[ind.length];
    if (ind.width >= 4) {
      const code = [], start = i;
      let end = i;
      while (i < rows.length) {
        if (isBlank(rows[i])) { code.push(expandLeading(rows[i]).slice(4)); i++; continue; }
        const l = expandLeading(rows[i]);
        if (leading(l).width < 4) break;
        code.push(rows[i].replace(/^(?: {4}| {0,3}\t)/, '')); end = ++i;
      }
      while (code.length && code.at(-1) === '') code.pop();
      const trailing = i - end;
      const blankGap = trailing > 0 && !(i === rows.length && trailing === 1 && rows.at(-1) === '');
      if (blankGap) i = end;
      if (previous && previous.paragraph) previous.text += '\n' + code.join('\n') + (!blankGap && end < rows.length ? '\n' : '');
      else parts.push('<pre><code>' + escapeText(code.join('\n'), true) + '\n</code></pre>\n');
      lastKind = previous && previous.paragraph ? 'paragraph' : 'code';
      if (lastKind === 'code') previous = null;
      continue;
    }
    const fence = blockChar === '`' || blockChar === '~' ? fenceStart(line) : null;
    if (fence) {
      const body = [], indent = line.length - line.trimStart().length;
      const close = new RegExp('^ {0,3}' + (fence[1][0] === '`' ? '`' : '~') + '{' + fence[1].length + ',} *$');
      i++;
      while (i < rows.length && !close.test(rows[i])) {
        if (i === rows.length - 1 && rows[i] === '') break;
        let content = rows[i];
        let spaces = 0;
        while (fence[1][0] === '`' && spaces < indent && /\s/.test(content[spaces] || '\0')) spaces++;
        body.push(content.slice(spaces)); i++;
      }
      if (i < rows.length && close.test(rows[i])) i++;
      const lang = unescapePunctuation(fence[2].trim()).split(/\s/, 1)[0];
      const codeText = body.join('\n');
      parts.push('<pre><code' + (lang ? ' class="language-' + escapeText(lang) + '"' : '') + '>' + (codeText ? escapeText(codeText.replace(/\n$/, ''), true) + '\n' : '') + '</code></pre>\n');
      previous = null; lastKind = 'code'; continue;
    }
    const h = blockChar === '#' ? /^ {0,3}(#{1,6})(?=\s|$)(.*)$/.exec(line) : null;
    if (h) {
      let text = h[2].trim();
      if (/(?:^|\s)#+$/.test(text)) text = text.replace(/(?:^|\s)#+$/, '').trimEnd();
      parts.push('<h' + h[1].length + '>'); inlinePart(text); parts.push('</h' + h[1].length + '>\n');
      i++; previous = null; lastKind = 'heading'; continue;
    }
    if ((blockChar === '-' || blockChar === '*' || blockChar === '_') && thematic(line)) {
      parts.push('<hr>\n'); i++; previous = null; lastKind = 'hr'; continue;
    }
    if (blockChar === '>') {
      const inner = [];
      let lazy = false, activeFence = null, fenceDepth = 0, activeHTML = null, htmlDepth = 0, activeList = null, afterLazy = false;
      const overrides = new Map();
      const boundaries = new Set();
      while (i < rows.length) {
        const quoted = /^( {0,3})>([ \t]*)(.*)$/.exec(rows[i]);
        if (quoted) {
          let space = quoted[2];
          if (space.includes('\t')) space = expandLeading(space, quoted[1].length + 1);
          const text = (space[0] === ' ' ? space.slice(1) : space) + quoted[3];
          const prefix = /^(?: {0,3}> ?)+/.exec(text)?.[0] || '';
          const quoteDepth = prefix.split('>').length - 1;
          if (afterLazy && activeList === quoteDepth) { boundaries.add(inner.length); activeList = null; }
          afterLazy = false;
          inner.push(text); i++;
          if (activeFence && quoteDepth < fenceDepth) activeFence = null;
          if (activeHTML && quoteDepth < htmlDepth) activeHTML = null;
          const tip = text.replace(/^(?: {0,3}> ?)+/, '').replace(/^ {0,3}(?:[-+*]|\d{1,9}[.)]) +/, '').replace(/^> ?/, '');
          const listTip = text.slice(prefix.length);
          if (listMarker(listTip)) activeList = quoteDepth;
          else if (isBlank(listTip) || activeList !== null && quoteDepth < activeList) activeList = null;
          if (activeFence) { if (new RegExp('^ {0,3}' + activeFence[0] + '{' + activeFence.length + ',} *$').test(tip)) activeFence = null; lazy = false; }
          else if (activeHTML) {
            if (activeHTML.blank ? isBlank(tip) : activeHTML.end.test(tip)) activeHTML = null;
            lazy = false;
          } else {
            const f = fenceStart(tip), h = htmlStart(tip);
            if (f) { activeFence = f[1]; fenceDepth = quoteDepth; }
            if (h && (h.blank || !h.end.test(tip))) { activeHTML = h; htmlDepth = quoteDepth; }
            lazy = !f && !h && !isBlank(tip) && !interrupt([tip], 0, true, false) && leading(tip).width < 4;
          }
        } else if (lazy && !interrupt(rows, i, true)) {
          const raw = rows[i++];
          afterLazy = true;
          if (leading(raw).width >= 4) overrides.set(inner.length, expandLeading(raw).slice(4));
          inner.push(/^ {0,3}(?:=+|-+) *$/.test(raw) ? '    ' + raw.trimStart() : raw);
        }
        else break;
      }
      const child = blockScan(inner.join('\n'), refs, true, overrides, boundaries);
      parts.push('<blockquote>\n', ...child.parts, '</blockquote>\n');
      previous = null; lastKind = 'blockquote'; continue;
    }
    const lm = blockChar === '-' || blockChar === '+' || blockChar === '*' || blockChar >= '0' && blockChar <= '9' ? listMarker(line) : null;
    if (lm) {
      const list = readList(rows, i, refs, listBoundaries);
      if (list) { parts.push(...list.parts); i = list.next; previous = null; lastKind = 'list'; continue; }
    }
    const html = blockChar === '<' ? htmlStart(line) : null;
    if (html) {
      const start = i;
      let trim = false;
      if (html.blank) {
        while (i < rows.length && !isBlank(rows[i])) i++;
        if (i < rows.length) { const b = i; while (i < rows.length && isBlank(rows[i])) i++; trim = b < rows.length - 1; }
      } else {
        while (i < rows.length) { const ended = html.end.test(rows[i]); i++; if (ended) break; }
        const b = i; while (i < rows.length && rows[i] === '') i++;
        trim = i - b > (i === rows.length ? 1 : 0);
      }
      const text = rows.slice(start, i).join('\n') + (i < rows.length ? '\n' : '');
      parts.push(trim ? text.replace(/\n[ \t]*(?:\n[ \t]*)*$/, '') : text); previous = null; lastKind = 'html'; continue;
    }
    const def = blockChar === '[' ? readDefinition(rows, i, refs) : 0;
    if (def) { i += def; previous = null; lastKind = 'def'; continue; }
    const table = tableInfo(rows, i);
    if (table) {
      parts.push('<table>\n<thead>\n<tr>\n');
      table.head.forEach((cell, col) => { parts.push('<th' + (table.align[col] ? ' align="' + table.align[col] + '"' : '') + '>'); inlinePart(cell); parts.push('</th>\n'); });
      parts.push('</tr>\n</thead>\n'); i += 2;
      let body = false;
      while (i < rows.length && tableRowContinues(rows[i])) {
        if (!body) { parts.push('<tbody>'); body = true; }
        const cells = tableCells(rows[i++]); parts.push('<tr>\n');
        table.head.forEach((_, col) => { parts.push('<td' + (table.align[col] ? ' align="' + table.align[col] + '"' : '') + '>'); inlinePart(cells[col] || ''); parts.push('</td>\n'); });
        parts.push('</tr>\n');
      }
      if (body) parts.push('</tbody>');
      parts.push('</table>\n'); previous = null; lastKind = 'table'; continue;
    }
    const text = [line]; i++;
    let depth = 0;
    while (i < rows.length) {
      if (continuations?.has(i)) { text.push(continuations.get(i)); i++; continue; }
      if (i === rows.length - 1 && rows[i].length && isBlank(rows[i])) { text.push(rows[i++]); break; }
      const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(rows[i]);
      if (setext) { depth = setext[1][0] === '=' ? 1 : 2; i++; break; }
      if (interrupt(rows, i, !wrap) || (!wrap && leading(rows[i]).width >= 4)) break;
      text.push(rows[i++]);
    }
    if (depth) {
      parts.push('<h' + depth + '>'); inlinePart(text.join('\n').trim()); parts.push('</h' + depth + '>\n');
      previous = null; lastKind = 'heading';
    } else if (!wrap && previous?.paragraph) previous.text += '\n' + text.join('\n');
    else inlinePart(text.join('\n'), true);
  }
  return { parts, paragraphs, blankBetween, lastKind };
}

function readList(rows, start, refs, boundaries = null) {
  const first = listMarker(rows[start]);
  if (!first || thematic(rows[start])) return null;
  const ordered = first.marker.length > 1, style = ordered ? first.marker.at(-1) : first.marker;
  const items = []; let i = start, loose = false, finalBlanks = 0;
  while (i < rows.length) {
    const mark = listMarker(rows[i]);
    if (!mark || thematic(rows[i]) || (mark.marker.length > 1) !== ordered || (ordered ? mark.marker.at(-1) : mark.marker) !== style) break;
    const itemStart = i, whole = expandLeading(mark.space + mark.content, mark.width);
    const pad = leading(whole).width;
    const empty = !whole.trim();
    const remove = empty ? 1 : pad > 4 ? 1 : pad;
    const indent = mark.width + remove;
    const content = [empty ? '' : whole.slice(remove)];
    let last = content[0], lastBlank = empty;
    i++;
    if (empty && i < rows.length && isBlank(rows[i])) { content.push(''); i++; }
    else while (i < rows.length) {
      if (boundaries?.has(i)) break;
      const raw = rows[i], expanded = expandLeading(raw), width = leading(expanded).width;
      const body = expanded.slice(width);
      if (!isBlank(raw) && width < indent && (listMarker(raw) || thematic(body) || headingStart(body) || /^(?:`{3,}|~{3,})/.test(body) || htmlStart(body) || body[0] === '>')) break;
      if (isBlank(raw) || width >= indent) content.push(expanded.slice(indent));
      else {
        if (lastBlank || leading(last).width >= 4 || /^ {0,3}(?:`{3,}|~{3,})/.test(last) || headingStart(last) || htmlStart(last) || thematic(last)) break;
        content.push(/^ {0,3}(?:=+|-+) *$/.test(raw) ? '    ' + expanded.trimStart() : raw);
      }
      lastBlank = isBlank(raw); last = expanded.slice(indent); i++;
    }
    const next = listMarker(rows[i] || '');
    const same = next && !thematic(rows[i]) && (next.marker.length > 1) === ordered && (ordered ? next.marker.at(-1) : next.marker) === style;
    finalBlanks = 0;
    for (let j = content.length - 1; j > 0 && isBlank(content[j]); j--) finalBlanks++;
    if (same && finalBlanks) loose = true;
    let src = content.join('\n');
    src = src.replace(/\n[ \t]*(?:\n[ \t]*)*$/, '');
    if (!same) src = src.trimEnd();
    let task = /^\[[ xX]\] /.exec(src), checkbox = '';
    if (task) checkbox = '<input ' + (task[0][1] !== ' ' ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
    const child = blockScan(src, refs, false);
    if (task && child.parts[0]?.paragraph) child.parts[0].text = child.parts[0].text.slice(task[0].length);
    else checkbox = '';
    if (child.blankBetween) loose = true;
    items.push({ child, checkbox, itemStart });
    if (i === itemStart) break;
  }
  const out = ['<' + (ordered ? 'ol' : 'ul') + (ordered && +first.marker.slice(0, -1) !== 1 ? ' start="' + +first.marker.slice(0, -1) + '"' : '') + '>\n'];
  for (const item of items) {
    out.push('<li>');
    for (const part of item.child.paragraphs) part.wrap = loose;
    if (item.checkbox) {
      const p = item.child.parts.find(p => typeof p === 'object' && p.paragraph);
      if (loose && p === item.child.parts[0]) p.checkbox = item.checkbox;
      else out.push(item.checkbox);
    }
    out.push(...item.child.parts);
    if (item.child.lastKind === 'html' && typeof out.at(-1) === 'string') out[out.length - 1] = out.at(-1).replace(/\n+$/, '');
    out.push('</li>\n');
  }
  out.push('</' + (ordered ? 'ol' : 'ul') + '>\n');
  return { parts: out, next: Math.max(start + 1, i - finalBlanks) };
}

function readCodeSpan(s, at) {
  let n = 1;
  while (s[at + n] === '`') n++;
  let i = at + n;
  while (i < s.length) {
    i = s.indexOf('`', i);
    if (i < 0) return null;
    let end = i + 1;
    while (s[end] === '`') end++;
    if (end - i === n && i > at + n) {
      let text = s.slice(at + n, i).replace(/\n/g, ' ');
      if (text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text)) text = text.slice(1, -1);
      return { end, text };
    }
    i = end;
  }
  return null;
}

function labelEnd(s, at) {
  let depth = 1;
  for (let i = at + 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '`') {
      let runEnd = i + 1; while (s[runEnd] === '`') runEnd++;
      if (runEnd - i >= 2 && s[runEnd] === ']') { i = runEnd - 1; continue; }
      let next = s.indexOf('`', runEnd);
      if (next < 0) { if (runEnd - i >= 2 && s[runEnd] === ']') { i = runEnd - 1; continue; } return -1; }
      while (s[next + 1] === '`') next++;
      i = next; continue;
    }
    if (s[i] === '<') {
      const token = angleToken(s, i);
      if (token) { i += token.length - 1; continue; }
    }
    if (s[i] === '[') depth++;
    else if (s[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

function readLink(s, at, refs, allowInline = true) {
  const image = s[at] === '!', open = at + (image ? 1 : 0), close = labelEnd(s, open);
  if (close < 0) return null;
  const label = s.slice(open + 1, close);
  let p = close + 1, href = '', title = '', end;
  if (s[p] === '(' && allowInline) {
    p++; while (/[ \t\n]/.test(s[p] || '\0')) p++;
    if (s[p] === '<') {
      let q = p + 1;
      while (q < s.length && s[q] !== '>' && s[q] !== '\n' && s[q] !== '<') { if (s[q] === '\\') q++; q++; }
      if (s[q] !== '>') return null;
      href = s.slice(p + 1, q); p = q + 1;
    } else {
      const begin = p; let level = 0;
      while (p < s.length) {
        const c = s[p];
        if (c === '\\' && s[p + 1]) { p += 2; continue; }
        if (c === '(') level++;
        if (c === ')') { if (!level) break; level--; }
        if (/[ \t\n\x00-\x1f]/.test(c)) break;
        p++;
      }
      if (level) return null;
      href = s.slice(begin, p);
    }
    const beforeSpace = p;
    while (/[ \t\n]/.test(s[p] || '\0')) p++;
    if (p > beforeSpace && /["'(]/.test(s[p] || '\0')) {
      const endChar = s[p] === '(' ? ')' : s[p], begin = ++p;
      while (p < s.length && s[p] !== endChar) { if (s[p] === '\\') p++; p++; }
      if (p === s.length) return null;
      title = s.slice(begin, p++);
      while (/[ \t\n]/.test(s[p] || '\0')) p++;
    }
    if (s[p] !== ')') return null;
    end = p + 1;
  } else {
    let key = label;
    if (s[p] === '[') {
      const q = s.indexOf(']', p + 1);
      if (q < 0) return null;
      key = s.slice(p + 1, q) || label; end = q + 1;
    } else end = p;
    const ref = refs.get(referenceKey(key));
    if (!ref) return null;
    href = ref.href; title = ref.title;
  }
  return { label, href: unescapePunctuation(href), title: unescapePunctuation(title), end, image };
}

function angleToken(s, at) {
  const tail = s.slice(at);
  const m = /^(?:<!--(?:-?>|[\s\S]*?-->)|<\/[a-z][a-z\d-]*\s*>|<[a-z][a-z\d-]*(?:\s+[a-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\?[\s\S]*?\?>|<![a-z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>|<[a-z][a-z\d+.\-]{1,31}:[^\s\x00-\x1f<>]*>)/i.exec(tail);
  return m ? m[0] : null;
}

function nestedLink(label, refs) {
  for (let p = 0; p < label.length; p++) {
    if (label[p] === '\\') { p++; continue; }
    if (label[p] === '`') { const code = readCodeSpan(label, p); if (code) { p = code.end - 1; continue; } }
    if (label[p] === '<') { const tag = angleToken(label, p); if (tag) { p += tag.length - 1; continue; } }
    if (label[p] === '!' && label[p + 1] === '[') { const image = readLink(label, p, refs); if (image) { p = image.end - 1; continue; } }
    if (label[p] === '[' && (readLink(label, p, refs) || readLink(label, p, refs, false))) return true;
  }
  return false;
}

function trimURL(s) {
  for (;;) {
    let i = 0;
    while (i < s.length) {
      const char = s[i];
      if (char === '(') {
        const end = s.indexOf(')', i + 1);
        if (end < 0) break;
        i = end + 1; continue;
      }
      if (char === '&' && /^&[a-z\d]+;$/i.test(s.slice(i))) break;
      if (/[?!.,:;*_\x27"~)]/.test(char)) {
        let end = i + 1;
        while (end < s.length && /[?!.,:;*_\x27"~)]/.test(s[end])) end++;
        if (end === s.length) break;
        i = end; continue;
      }
      i++;
    }
    if (i === s.length) break;
    s = s.slice(0, i);
  }
  return s;
}

function bareLink(s, at) {
  const tail = s.slice(at), prev = at ? s[at - 1] : '';
  let m;
  if (/^(?:https?:\/\/|ftp:\/\/)/i.test(tail) || (tail.startsWith('www.') && (!prev || /[\s*_~(]/.test(prev)))) {
    m = /^(?:(?:https?|ftp):\/\/|www\.)(?:[a-z\d-]+\.?)+[^\s<]*/i.exec(tail);
    if (m) {
      const raw = trimURL(m[0]);
      if (raw) return { raw, href: raw.startsWith('www.') ? 'http://' + raw : raw };
    }
  }
  m = /^(?:(?:mailto|xmpp):)?[A-Za-z\d._+\-]+@[a-z\d_-]+(?:\.[a-z\d_-]*[a-z\d])+(?![\w-])(?:\/[a-z\d@.]+)?/i.exec(tail);
  if (m && (!prev || !/[A-Za-z\d._+\-]/.test(prev))) {
    let raw = m[0];
    if (!tail.startsWith('xmpp:')) raw = raw.split('/')[0];
    return { raw, href: /^(?:mailto|xmpp):/.test(raw) ? raw : 'mailto:' + raw };
  }
  return null;
}

function flanking(s, at, length, char) {
  const before = at ? String.fromCodePoint(s.codePointAt(at - (s.charCodeAt(at - 1) >= 0xdc00 && s.charCodeAt(at - 1) <= 0xdfff ? 2 : 1))) : '';
  const after = at + length < s.length ? String.fromCodePoint(s.codePointAt(at + length)) : '';
  const bw = !before || whitespace.test(before), aw = !after || whitespace.test(after);
  const bp = before && punctuation.test(before) && (char === '_' || before !== '~'), ap = after && punctuation.test(after) && (char === '_' || after !== '~');
  let open = !aw && (!ap || bw || bp), close = !bw && (!bp || aw || ap);
  if (char === '_') { const l = open, r = close; open = l && (!r || bp); close = r && (!l || ap); }
  return { open: !!open, close: !!close };
}

function emphasisMask(source, refs) {
  // Keep offsets stable while hiding delimiters inside literal syntax.
  if (!/[\\`[<]/.test(source)) return source;
  const original = source;
  const references = [];
  if (refs.size && source.includes('[')) {
    let from = 0;
    for (;;) {
      let at = source.indexOf('[', from);
      if (at < 0) break;
      if (at && source[at - 1] === '!') at--;
      const ref = readLink(source, at, refs, false);
      if (ref && source[ref.end] !== '(' && !nestedLink(ref.label, refs)) {
        references.push([at, ref.end]); from = ref.end;
      } else from = at + (source[at] === '!' ? 2 : 1);
    }
    if (references.length) {
      let hidden = '', start = 0;
      for (const [a, b] of references) { hidden += source.slice(start, a) + '[' + 'a'.repeat(b - a - 2) + ']'; start = b; }
      source = hidden + source.slice(start);
    }
  }
  const edits = [];
  let scan = 0, match;
  for (;;) {
    maskLiteral.lastIndex = scan; match = maskLiteral.exec(source);
    if (!match) break;
    let i = match.index;
    if (source[i] === '\\' && punctuation.test(String.fromCodePoint(source.codePointAt(i + 1) || 0))) {
      const n = source.codePointAt(i + 1) > 0xffff ? 3 : 2;
      edits.push([i, i + n, '+'.repeat(n)]); i += n - 1;
    } else if (source[i] === '`') {
      const code = readCodeSpan(source, i);
      if (code) {
        const raw = source.slice(i, code.end), n = /^`+/.exec(raw)[0].length;
        edits.push([i, code.end, raw.slice(0, n) + raw.slice(n, -n).replace(/`/g, '+') + raw.slice(-n)]);
        i = code.end - 1;
      } else { while (source[i + 1] === '`') i++; }
    }
    scan = i + 1;
  }
  let sanitized = '', start = 0;
  for (const [a, b, text] of edits) { sanitized += source.slice(start, a) + text; start = b; }
  sanitized += source.slice(start);
  const spans = [];
  scan = 0;
  let refIndex = 0;
  for (;;) {
    maskSyntax.lastIndex = scan; match = maskSyntax.exec(sanitized);
    if (!match) break;
    let i = match.index;
    while (refIndex < references.length && references[refIndex][1] <= i) refIndex++;
    if (refIndex < references.length && i >= references[refIndex][0]) { scan = references[refIndex][1]; continue; }
    if (sanitized[i] === '[' || sanitized[i] === '!' && sanitized[i + 1] === '[') {
      const link = readLink(sanitized, i, refs) || readLink(sanitized, i, refs, false);
      if (link && maskableLabel(link.label) && !nestedLink(original.slice(i + 1, i + 1 + link.label.length), refs)) { spans.push([i, link.end]); scan = link.end; continue; }
    }
    if (sanitized[i] === '`') {
      const code = readCodeSpan(sanitized, i);
      if (code) { spans.push([i, code.end]); scan = code.end; continue; }
      while (sanitized[i + 1] === '`') i++;
    }
    if (sanitized[i] === '<' && sanitized[i + 1] !== ' ') {
      const end = sanitized.indexOf('>', i + 1);
      if (end >= 0 && !sanitized.slice(i + 1, end).includes('<')) { spans.push([i, end + 1]); i = end; }
    }
    scan = i + 1;
  }
  let mask = ''; start = 0;
  for (const [a, b] of spans) { mask += sanitized.slice(start, a) + '[' + 'a'.repeat(Math.max(0, b - a - 2)) + ']'; start = b; }
  return mask + sanitized.slice(start);
}

function maskableLabel(label) {
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = readCodeSpan(label, i);
      if (!code) return false;
      i = code.end - 1;
    }
  }
  return true;
}

function emphasisEnd(source, mask, at, previousText) {
  const char = source[at];
  let count = 1; while (source[at + count] === char) count++;
  if (char === '~' && count > 2) return null;
  const after = source[at + count] || '';
  if (!after || whitespace.test(after) || after === char) return null;
  let beginning = at;
  while (beginning && mask[beginning - 1] === char) beginning--;
  const prior = beginning < at ? mask[beginning - 1] || '' : previousText;
  const priorPunctuation = !prior || whitespace.test(prior) || punctuation.test(prior);
  const afterPunctuation = punctuation.test(after) && (char !== '*' || after !== '~');
  if (afterPunctuation && prior && !priorPunctuation) return null;
  if (char === '_' && /[\p{L}\p{N}]/u.test(prior)) return null;
  const initial = count + at - beginning;
  const ambiguousStart = prior && !whitespace.test(prior) && (afterPunctuation || char === '*' && !priorPunctuation);
  let balance = count, ignored = 0, pos = at + count;
  let skipAt = -1;
  if (char !== '~') {
    const other = char === '*' ? '_' : '*';
    let p = pos;
    while (p < mask.length && mask[p] !== char && mask[p] !== other) p++;
    if (mask[p] === other && mask[p + 1] === other) {
      p += 2;
      while (p < mask.length && mask[p] !== char && mask[p] !== other) p++;
      const own = p;
      if (mask[p] === char) {
        p++;
        while (p < mask.length && mask[p] !== char && mask[p] !== other) p++;
        if (mask[p] === other && mask[p + 1] === other) skipAt = own;
      }
    }
  }
  while (pos < mask.length) {
    pos = mask.indexOf(char, pos);
    if (pos < 0) break;
    let length = 1; while (mask[pos + length] === char) length++;
    if (pos === skipAt) { pos += length; continue; }
    const right = flanking(mask, pos, length, char);
    if (char === '~' && length !== count) { pos += length; continue; }
    if (right.open && !right.close) { balance += length; pos += length; continue; }
    if (!right.close) { pos += length; continue; }
    if (char !== '~' && (right.open || ambiguousStart)) {
      if (previousText === char && right.open) break;
      if (initial % 3 && (initial + length) % 3 === 0) { ignored += length; pos += length; continue; }
    }
    balance -= length;
    if (balance > 0) { pos += length; continue; }
    const consume = Math.min(length, length + balance + ignored);
    const used = char === '~' ? count : Math.min(count, consume) % 2 ? 1 : 2;
    return { end: pos + consume, start: at + used, stop: pos + consume - used, tag: char === '~' ? 'del' : used === 2 ? 'strong' : 'em' };
  }
  return null;
}

function renderInline(s, refs, mode = 0, state = { rawTag: false, inAnchor: false }, inheritedMask = null) {
  if (!simpleInline.test(s) && !urlHint.test(s)) return state.rawTag && mode !== 2 ? s : plainText(s);
  return scanInline(s, refs, mode, state, inheritedMask);
}

function scanInline(s, refs, mode, state, inheritedMask) {
  // mode 1 is link text; mode 2 is image text, which keeps raw tags as text.
  let html = '';
  let i = 0, rawTag = state.rawTag, inAnchor = mode === 1 || state.inAnchor, mask = inheritedMask, textContext = '';
  const emailPossible = s.includes('@');
  const push = text => { html += text; };
  while (i < s.length) {
    const c = s[i];
    const previousText = textContext; textContext = '';
    if (c === '\\') {
      if (s[i + 1] === '\n' && i + 2 < s.length && !/^\s*$/.test(s.slice(i + 2))) {
        push(mode === 2 ? '' : '<br>'); i += 2; while (s[i] === ' ' || s[i] === '\t') i++; continue;
      }
      if (/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(s[i + 1] || '\0')) { push(escapeText(s[i + 1], true)); i += 2; continue; }
    }
    if (c === '`' && !rawTag) {
      const code = readCodeSpan(s, i);
      if (code) { push((mode === 2 ? '' : '<code>') + escapeText(code.text, true) + (mode === 2 ? '' : '</code>')); i = code.end; continue; }
      let end = i + 1; while (s[end] === '`') end++;
      push(s.slice(i, end)); i = end; continue;
    }
    if ((c === '[' || c === '!' && s[i + 1] === '[') && !rawTag) {
      const link = readLink(s, i, refs) || readLink(s, i, refs, false);
      if (link) {
        if (!link.image && nestedLink(link.label, refs)) { push('['); i++; continue; }
        const url = destination(link.href);
        if (url !== null) {
          const title = link.title ? ' title="' + escapeText(link.title) + '"' : '';
          if (link.image) {
            const alt = renderInline(link.label, refs, 2, { rawTag, inAnchor: true });
            push(mode === 2 ? alt : '<img src="' + url + '" alt="' + alt + '"' + title + '>');
          } else {
            const label = renderInline(link.label, refs, mode === 2 ? 2 : 1, { rawTag, inAnchor: true });
            push(mode === 2 ? label : '<a href="' + url + '"' + title + '>' + label + '</a>');
          }
          i = link.end; continue;
        }
      }
    }
    if (c === '<') {
      const tail = s.slice(i);
      const auto = /^<([a-z][a-z\d+.\-]{1,31}:[^\s\x00-\x1f<>]*|[A-Za-z\d.!#$%&'*+/=?_`{|}~\-]+@[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+)>/i.exec(tail);
      if (auto) {
        const url = auto[1], href = /^[a-z][a-z\d+.\-]*:/i.test(url) ? url : 'mailto:' + url;
        push(mode === 2 ? escapeText(url) : '<a href="' + destination(href) + '">' + escapeText(url) + '</a>');
        i += auto[0].length; continue;
      }
      const tag = /^(?:<!--(?:-?>|[\s\S]*?-->)|<\/[a-z][a-z\d-]*\s*>|<[a-z][a-z\d-]*(?:\s+[a-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\?[\s\S]*?\?>|<![a-z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>)/i.exec(tail);
      if (tag) {
        push(mode === 2 ? escapeText(tag[0]) : tag[0]);
        if (/^<a\s/i.test(tag[0])) inAnchor = true;
        else if (/^<\/a\s*>/i.test(tag[0])) inAnchor = mode === 1;
        if (/^<(?:pre|code|kbd|script)(?:\s|>)/i.test(tag[0])) rawTag = true;
        else if (/^<\/(?:pre|code|kbd|script)\s*>/i.test(tag[0])) rawTag = false;
        state.rawTag = rawTag; state.inAnchor = inAnchor;
        i += tag[0].length; continue;
      }
    }
    if (rawTag) {
      let end = s.indexOf('<', i + 1); if (end < 0) end = s.length;
      push(mode === 2 ? escapeText(s.slice(i, end)) : s.slice(i, end)); i = end; continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let n = 1; while (s[i + n] === c) n++;
      mask ??= emphasisMask(s, refs);
      const em = mask[i] === c ? emphasisEnd(s, mask, i, previousText) : null;
      if (em) {
        const body = renderInline(s.slice(em.start, em.stop), refs, mode, state, mask.slice(em.start, em.stop));
        rawTag = state.rawTag; inAnchor = mode === 1 || state.inAnchor;
        push(mode === 2 ? body : '<' + em.tag + '>' + body + '</' + em.tag + '>');
        i = em.end; continue;
      }
      const literalLength = c === '~' ? n : 1;
      push(c.repeat(literalLength)); textContext = c === '_' ? previousText : c;
      i += literalLength; continue;
    }
    if (c === ' ') {
      let end = i + 1; while (s[end] === ' ') end++;
      if (end - i >= 2 && s[end] === '\n' && !/^\s*$/.test(s.slice(end + 1))) {
        push(mode === 2 ? '' : '<br>'); i = end + 1; while (s[i] === ' ' || s[i] === '\t') i++; continue;
      }
    }
    if (!inAnchor && mode !== 2 && (emailPossible ? /[A-Za-z\d._+\-]/.test(c) : c === 'h' || c === 'H' || c === 'f' || c === 'F' || c === 'w' || c === 'm' || c === 'x')) {
      const link = bareLink(s, i);
      if (link) { push('<a href="' + destination(link.href) + '">' + escapeText(link.raw) + '</a>'); i += link.raw.length; continue; }
    }
    if (c === '\n' && /^<(?:!--|\?)/.test(s.slice(i + 1))) { i++; continue; }
    const boundary = inAnchor || mode === 2 ? literalBoundary : emailPossible ? plainBoundary : urlBoundary;
    boundary.lastIndex = i + 1;
    const next = boundary.exec(s);
    const end = next ? next.index : s.length;
    push(plainText(s.slice(i, end)));
    textContext = s[end - 1] === '_' ? previousText : s[end - 1]; i = end;
  }
  return html;
}

export function parse(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('Markdown must be a string');
  if (!markdown) return '';
  const refs = new Map();
  const blocks = blockScan(markdown.indexOf('\r') >= 0 ? markdown.replace(/\r\n?/g, '\n') : markdown, refs);
  const state = { rawTag: false, inAnchor: false };
  let html = '';
  for (const p of blocks.parts) {
    if (typeof p === 'string') html += p;
    else {
      const text = (p.checkbox || '') + renderInline(p.text, refs, 0, state);
      html += p.paragraph && p.wrap ? '<p>' + text + '</p>\n' : text;
    }
  }
  return html;
}
