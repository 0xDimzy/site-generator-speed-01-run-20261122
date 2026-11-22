// Faster drop-in for makefun-site 1.0.0: run(input) returns the same output tree
// (path -> text) as the reference build, byte for byte. Dependency-free ES module.
// Speed comes from run-batched escaping, manual line classification, per-case
// slug/date/link caches and allocation-light counting; semantics mirror the
// reference exactly (front matter, Markdown subset, template dialect, slugs,
// report). Caches live inside one run() call: nothing carries between cases.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** JS \s test on a code unit. */
function isWS(code) {
  return code === 32 || (code >= 9 && code <= 13) || code === 160 || code === 5760 ||
    (code >= 8192 && code <= 8202) || code === 8232 || code === 8233 || code === 8239 ||
    code === 8287 || code === 12288 || code === 65279;
}

const WS_TABLE = new Uint8Array(128);
for (let c = 0; c < 128; c++) WS_TABLE[c] = isWS(c) ? 1 : 0;

const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST = /[&<>"']/;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escape & < > " ' ; returns the input untouched when it holds none. */
function escapeHtml(text) {
  if (!ESCAPE_TEST.test(text)) return text;
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

/** Escape one character (only > among the escapable set needs it, but stay general). */
function escapeChar(ch) {
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '"') return '&quot;';
  if (ch === "'") return '&#39;';
  return ch;
}

function slugifyRaw(text) {
  // ASCII fast path: NFKD is the identity and there are no combining marks.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      let keep = null;
      if (code >= 65 && code <= 90) keep = String.fromCharCode(code + 32);
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = text[i];
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDateRaw(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Count runs of non-whitespace (the reference's wordsOf, without the array). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 128 ? WS_TABLE[code] === 1 : isWS(code)) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isDigitCode(c) { return c >= 48 && c <= 57; }

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) {
        for (const p of [0, 1, 2, 3, 5, 6, 8, 9]) if (!isDigitCode(raw.charCodeAt(p))) { ok = false; break; }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t[i];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || isDigitCode(c) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true; // start acts like after a dash: first char must be alnum
      let ok = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if ((c >= 97 && c <= 122) || isDigitCode(c)) prevDash = false;
        else if (c === 45 && !prevDash) prevDash = true;
        else { ok = false; break; }
      }
      if (prevDash) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Parse "key: value" line manually, mirroring /^([a-z_]+):(?: (.*))?$/. Returns [key, raw] or null. */
function parseKeyLine(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 97 && c <= 122) || c === 95) i++;
    else break;
  }
  if (i === 0 || line[i] !== ':') return null;
  const key = line.slice(0, i);
  if (i + 1 === line.length) return [key, ''];
  if (line[i + 1] !== ' ') return null;
  let raw = line.slice(i + 2);
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === ' ' || raw[end - 1] === '\t')) end--;
  if (end !== raw.length) raw = raw.slice(0, end);
  return [key, raw];
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

function parseFrontMatter(text) {
  // First line must be exactly "---".
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  const fmLines = [];
  let pos = firstNl + 1;
  let bodyStart = -1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    if (line === '---') { bodyStart = nl === -1 ? text.length : nl + 1; break; }
    fmLines.push(line);
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let idx = 0; idx < fmLines.length; idx++) {
    const line = fmLines[idx];
    if (isBlankLine(line) || line.startsWith('#')) continue;
    const parsed = parseKeyLine(line);
    if (parsed === null) return { error: `line ${idx + 2} is not "key: value"` };
    const key = parsed[0];
    const raw = parsed[1];
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Fence open: returns the language (possibly "") or null. Mirrors /^```([A-Za-z0-9_+-]*)[ \t]*$/. */
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || isDigitCode(c) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return null;
    i++;
  }
  return lang;
}

function fenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** Heading: {depth, text} or null. Mirrors /^(#{1,6})[ \t]+(.*?)[ \t]*$/ with non-empty text. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length || (line[n] !== ' ' && line[n] !== '\t')) return null;
  let a = n;
  while (a < line.length && (line[a] === ' ' || line[a] === '\t')) a++;
  let b = line.length;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  if (b <= a) return null;
  return { depth: n, text: line.slice(a, b) };
}

function isHR(line) {
  if (!(line.startsWith('---') || line.startsWith('***'))) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** Bullet marker: captured rest or null. Mirrors /^[-*] (.*)$/. */
function bulletOf(line) {
  if (line.length < 2) return null;
  const c = line[0];
  if ((c !== '-' && c !== '*') || line[1] !== ' ') return null;
  return line.slice(2);
}

/** Ordered marker: {num, rest} or null. Mirrors /^(\d{1,9})\. (.*)$/. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && isDigitCode(line.charCodeAt(i))) i++;
  if (i === 0 || i > 9) return null;
  if (line[i] !== '.' || line[i + 1] !== ' ') return null;
  return { num: Number(line.slice(0, i)), rest: line.slice(i + 2) };
}

/** Continuation line. Mirrors /^ {2,}\S/. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i < 2 || i >= line.length) return false;
  return !isWS(line.charCodeAt(i));
}

function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  for (let j = from; j <= hi - wlen; j++) {
    if (s[j] === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (j + 1 < hi && s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

/** Render inline markup in s[lo, hi) into parts. env.link(target) resolves hrefs. */
function inlineRange(s, lo, hi, env, parts) {
  let i = lo;
  let run = lo;
  while (i < hi) {
    const c = s[i];
    if (c === '\\' && i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
      if (i > run) parts.push(escapeHtml(s.slice(run, i)));
      parts.push(escapeChar(s[i + 1]));
      i += 2;
      run = i;
      continue;
    }
    if (c === '`') {
      let j = s.indexOf('`', i + 1);
      if (j >= hi) j = -1;
      if (j > i + 1) {
        if (i > run) parts.push(escapeHtml(s.slice(run, i)));
        parts.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (i + 1 < hi && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j > i + 2) {
          if (i > run) parts.push(escapeHtml(s.slice(run, i)));
          parts.push('<strong>');
          inlineRange(s, i + 2, j, env, parts);
          parts.push('</strong>');
          i = j + 2;
          run = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j > i + 1) {
        if (i > run) parts.push(escapeHtml(s.slice(run, i)));
        parts.push('<em>');
        inlineRange(s, i + 1, j, env, parts);
        parts.push('</em>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, hi);
      let m = -1;
      if (k !== -1 && k + 1 < hi && s[k + 1] === '(') {
        m = s.indexOf(')', k + 2);
        if (m >= hi) m = -1;
      }
      let ok = false;
      if (m !== -1 && m > k + 2) {
        ok = true;
        for (let p = k + 2; p < m; p++) if (isWS(s.charCodeAt(p))) { ok = false; break; }
      }
      if (ok) {
        if (i > run) parts.push(escapeHtml(s.slice(run, i)));
        parts.push(`<a href="${escapeHtml(env.link(s.slice(k + 2, m)))}">`);
        inlineRange(s, i + 1, k, env, parts);
        parts.push('</a>');
        i = m + 1;
        run = i;
      } else i++;
      continue;
    }
    i++;
  }
  if (hi > run) parts.push(escapeHtml(s.slice(run, hi)));
}

function inline(s, env) {
  const parts = [];
  inlineRange(s, 0, s.length, env, parts);
  return parts.join('');
}

const K_OTHER = 0;
const K_BLANK = 1;
const K_FENCE = 2;
const K_HEADING = 3;
const K_HR = 4;
const K_QUOTE = 5;
const K_BULLET = 6;
const K_ORDERED = 7;

/** Classify one line once, in the lexer's order. Returns [kind, aux]. */
function classifyLine(line) {
  if (isBlankLine(line)) return [K_BLANK, null];
  const lang = fenceOpen(line);
  if (lang !== null) return [K_FENCE, lang];
  const heading = headingOf(line);
  if (heading !== null) return [K_HEADING, heading];
  if (isHR(line)) return [K_HR, null];
  if (line[0] === '>') return [K_QUOTE, null];
  const bullet = bulletOf(line);
  if (bullet !== null) return [K_BULLET, bullet];
  const ordered = orderedOf(line);
  if (ordered !== null) return [K_ORDERED, ordered];
  return [K_OTHER, null];
}

/** Render a body: { html, toc, excerpt }. ctx carries slugify + caches. */
function renderMarkdown(src, env, ctx) {
  const lines = src.split('\n');
  const kinds = new Array(lines.length);
  const auxes = new Array(lines.length);
  for (let n = 0; n < lines.length; n++) {
    const c = classifyLine(lines[n]);
    kinds[n] = c[0];
    auxes[n] = c[1];
  }
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const kind = kinds[i];
    if (kind === K_BLANK) { i++; continue; }
    if (kind === K_FENCE) {
      const lang = auxes[i];
      const bodyParts = [];
      i++;
      while (i < lines.length && !fenceClose(lines[i])) {
        bodyParts.push(escapeHtml(lines[i]), '\n');
        i++;
      }
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      blocks.push(`<pre><code${cls}>${bodyParts.join('')}</code></pre>`);
      continue;
    }
    if (kind === K_HEADING) {
      const heading = auxes[i];
      const id = uniqueSlug(ctx.slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (kind === K_HR) { blocks.push('<hr>'); i++; continue; }
    if (kind === K_QUOTE) {
      const kept = [];
      while (i < lines.length && kinds[i] === K_QUOTE) {
        let rest = lines[i].slice(1);
        if (rest[0] === ' ') rest = rest.slice(1);
        const t = trimLine(rest);
        if (t !== '') kept.push(t);
        i++;
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    if (kind === K_BULLET || kind === K_ORDERED) {
      const isOrdered = kind === K_ORDERED;
      const want = kind;
      const firstNum = isOrdered ? auxes[i].num : 1;
      const items = [];
      while (i < lines.length) {
        if (kinds[i] === want) {
          items.push([trimLine(isOrdered ? auxes[i].rest : auxes[i])]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && firstNum !== 1 ? `<ol start="${firstNum}">` : `<${tag}>`;
      const itemParts = items.map((partsArr) => `<li>${inline(partsArr.join('\n'), env)}</li>\n`);
      blocks.push(`${open}\n${itemParts.join('')}</${tag}>`);
      continue;
    }
    const body = [trimLine(lines[i])];
    i++;
    while (i < lines.length) {
      const k = kinds[i];
      if (k === K_BLANK || k === K_FENCE || k === K_HEADING || k === K_HR) break;
      body.push(trimLine(lines[i]));
      i++;
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Lookup over a scope stack (array of vars objects, innermost last). */
function lookupStack(stack, path) {
  let v;
  let found = false;
  for (let i = stack.length - 1; i >= 0; i--) {
    if (Object.hasOwn(stack[i], path[0])) { v = stack[i][path[0]]; found = true; break; }
  }
  if (!found) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** Compile a parsed template into a function(stack, depth, parts). Same semantics as renderNodes. */
function compileTemplate(nodes, helpers) {
  const consts = [];
  const constIdx = (path) => { consts.push(path); return consts.length - 1; };
  let uid = 0;
  const gen = (list) => {
    let code = '';
    for (const n of list) {
      switch (n.kind) {
        case 'text':
          code += `P.push(${JSON.stringify(n.text)});`;
          break;
        case 'var':
          code += `P.push(H.esc(H.txt(H.lk(S,C[${constIdx(n.path)}]))));`;
          break;
        case 'raw':
          code += `P.push(H.txt(H.lk(S,C[${constIdx(n.path)}])));`;
          break;
        case 'if': {
          const cond = `H.tru(H.lk(S,C[${constIdx(n.path)}]))!==${n.not ? 'true' : 'false'}`;
          code += `if(${cond}){${gen(n.then)}}`;
          if (n.else !== null) code += `else{${gen(n.else)}}`;
          break;
        }
        case 'for': {
          const id = uid++;
          code += `{const xs${id}=H.lk(S,C[${constIdx(n.path)}]);if(Array.isArray(xs${id})){for(let k${id}=0;k${id}<xs${id}.length;k${id}++){S.push({${JSON.stringify(n.name)}:xs${id}[k${id}],loop:{index:k${id}+1,first:k${id}===0,last:k${id}===xs${id}.length-1,length:xs${id}.length}});${gen(n.body)}S.pop();}}}`;
          break;
        }
        case 'include':
          code += `H.inc(${JSON.stringify(n.name)},S,D,P);`;
          break;
      }
    }
    return code;
  };
  const body = gen(nodes);
  return new Function('H', 'C', `return function(S,D,P){${body}}`)(helpers, consts);
}

function renderNodes(nodes, scope, ctx, depth, parts) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    switch (n.kind) {
      case 'text':
        parts.push(n.text);
        break;
      case 'var':
        parts.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        parts.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, parts);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, parts);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, parts);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Scheme test mirroring /^[A-Za-z][A-Za-z0-9+.-]*:/. */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || isDigitCode(c) || c === 43 || c === 46 || c === 45)) return false;
  }
  return false;
}

/** One case's answer: the output tree (path -> text). */
export function run(input) {
  // Per-case caches (nothing cached between cases).
  const slugCache = new Map();
  const slugify = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) { v = slugifyRaw(text); slugCache.set(text, v); }
    return v;
  };
  const dateCache = new Map();
  const longDate = (date) => {
    let v = dateCache.get(date);
    if (v === undefined) { v = longDateRaw(date); dateCache.set(date, v); }
    return v;
  };

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  let base = input.site.base_url;
  while (base.endsWith('/')) base = base.slice(0, -1);

  // 1. Sources sorted by path; .md sources get \n line ends, the rest are static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter + refusal checks, in the reference's order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: slug unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    return set;
  };
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown with link resolution.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map(); // dir + \n + target -> [href, isBroken]
  const mdCtx = { slugify };
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const cacheKey = `${dir}\n${target}`;
        const hit = linkCache.get(cacheKey);
        if (hit !== undefined) {
          if (hit[1]) broken.add(`broken-link ${s.path} -> ${target}`);
          return hit[0];
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        let href;
        let isBroken = false;
        if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
        else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
        else { href = target; isBroken = true; }
        linkCache.set(cacheKey, [href, isBroken]);
        if (isBroken) broken.add(`broken-link ${s.path} -> ${target}`);
        return href;
      },
    };
    const md = renderMarkdown(s.body, env, mdCtx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, then by slug; neighbours linked.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags grouped by slug.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push([name, slug]); }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const [name, slug] of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map(([name, slug]) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards / pages as templates read them.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => {
    if (s._card !== undefined) return s._card;
    if (s._reading === undefined) s._reading = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: s._reading,
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s._card = card;
    return card;
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Layouts.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const compiled = new Map();
  const helpers = {
    esc: escapeHtml,
    txt: textOf,
    tru: truthy,
    lk: lookupStack,
    inc: (name, S, D, P) => {
      if (D >= INCLUDE_DEPTH) return;
      const f = compiled.get(name);
      if (f !== undefined) { f(S, D + 1, P); return; }
      const nodes = templates.get(name);
      if (nodes === undefined) return;
      let scope = null;
      for (let i = 0; i < S.length; i++) scope = { vars: S[i], parent: scope };
      renderNodes(nodes, scope, ctx, D + 1, P);
    },
  };
  for (const [name, nodes] of templates) {
    try { compiled.set(name, compileTemplate(nodes, helpers)); } catch { /* tree walk below */ }
  }
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const parts = [];
    const rootVars = { site, tags: allTags, recent, ...vars };
    const fn = compiled.get(name);
    if (fn !== undefined) fn([rootVars], 0, parts);
    else renderNodes(nodes, { vars: rootVars, parent: null }, ctx, 0, parts);
    return parts.join('');
  };
  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
