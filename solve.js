// solve.js — a fast drop-in for makefun-site 1.0.0.
//
// Same output as makefun-site's build() for every input, byte for byte, but
// written for speed: single-pass Markdown (no token objects), bulk inline
// scanning (no char-by-char walk), an ASCII fast path for slugs, cached
// per-source cards, and a template renderer that pushes into one shared
// array with a flat merged scope instead of a scope chain.
//
// The input: { site: { title, base_url, per_page, recent },
//              templates: { name: source },
//              files: [{ path, content }] }.
// run(input) returns the output tree: path -> text, as a JSON object.

// ------------------------------------------------------------------ text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;

// The slug of `text`. ASCII fast path: plain ASCII never changes under NFKD
// and holds no combining marks, so the normalize + mark strip is a no-op.
function slugify(text) {
  let plain = text;
  if (/[^\x00-\x7F]/.test(text)) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// ------------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
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
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let i = 0; i < tags.length; i++) {
        if (tags[i] === '' || !TAG.test(tags[i])) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

// A source's front matter and body: { data, body }, or { error }.
// Finds the closing '---' line without splitting the whole body.
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // Locate the closing line: a line that is exactly '---'.
  let closeLine = -1; // index of the closing line, 1-based line number
  let closeStart = -1; // char index where the closing line starts
  let closeEnd = -1; // char index just past the closing line's '\n' (or text end)
  let pos = 4; // char index after the opening '---\n' (or after '---' at end)
  let lineNo = 1; // the opening '---' is line 1
  if (text === '---') return { error: 'the front matter is not closed' };
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    lineNo++;
    if (line === '---') {
      closeLine = lineNo;
      closeStart = pos;
      closeEnd = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const fmText = text.slice(4, closeStart);
  const fmLines = fmText === '' ? [] : fmText.split('\n');
  // fmLines holds lines 2..closeLine-1; drop the trailing '' from the '\n' before the closing line.
  if (fmLines.length > 0 && fmLines[fmLines.length - 1] === '') fmLines.pop();
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (/^[ \t]*$/.test(line) || line[0] === '#') continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${j + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (KEYS.indexOf(key) === -1) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ------------------------------------------------------------------ markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  return BLANK.test(line) || FENCE_OPEN.test(line) || headingOf(line) !== null || HR.test(line);
}

// A paragraph line as it is rendered: spaces and tabs at either end dropped.
// Returns the line itself when nothing is dropped, so no string is built.
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

// First index from `from` where `s` holds `what` outside a backslash escape, or -1.
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

// First single * from `from` (one whose run is not **), outside an escape, or -1.
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// Next index at or after `from` holding one of \ ` * [, or -1.
function nextSpecial(s, from) {
  const a = s.indexOf('\\', from);
  const b = s.indexOf('`', from);
  const c = s.indexOf('*', from);
  const d = s.indexOf('[', from);
  let m = -1;
  if (a !== -1) m = a;
  if (b !== -1 && (m === -1 || b < m)) m = b;
  if (c !== -1 && (m === -1 || c < m)) m = c;
  if (d !== -1 && (m === -1 || d < m)) m = d;
  return m;
}

// `s` rendered inline; `env.link(target)` is a link's href.
// Bulk-scans plain text between special characters instead of walking char by char.
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const sp = nextSpecial(s, i);
    if (sp === -1) {
      out += escapeHtml(s.slice(i));
      break;
    }
    if (sp > i) out += escapeHtml(s.slice(i, sp));
    const c = s[sp];
    if (c === '\\' && sp + 1 < n && ESCAPABLE.has(s[sp + 1])) {
      out += escapeHtml(s[sp + 1]);
      i = sp + 2;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', sp + 1);
      if (j > sp + 1) {
        out += `<code>${escapeHtml(s.slice(sp + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i = sp + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[sp + 1] === '*') {
        const j = findUnescaped(s, '**', sp + 2);
        if (j > sp + 2) {
          out += `<strong>${inline(s.slice(sp + 2, j), env)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i = sp + 2;
        }
        continue;
      }
      const j = findSingleStar(s, sp + 1);
      if (j > sp + 1) {
        out += `<em>${inline(s.slice(sp + 1, j), env)}</em>`;
        i = j + 1;
      } else {
        out += '*';
        i = sp + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', sp + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(sp + 1, k), env)}</a>`;
        i = m + 1;
        continue;
      }
      out += '[';
      i = sp + 1;
      continue;
    }
    // A lone backslash before a non-escapable character: itself, escaped.
    out += escapeHtml(c);
    i = sp + 1;
  }
  return out;
}

// `src` rendered in one pass over its lines (no token objects): its HTML, its
// table of contents (level 2 and 3 headings) and its excerpt (first paragraph).
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  let i = 0;
  const total = lines.length;
  while (i < total) {
    const line = lines[i];
    if (BLANK.test(line)) {
      i++;
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      const body = [];
      i++;
      while (i < total && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
      let code = '<pre><code' + cls + '>';
      for (let k = 0; k < body.length; k++) code += escapeHtml(body[k]) + '\n';
      blocks.push(code + '</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push('<hr>\n');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      while (i < total && lines[i][0] === '>') body.push(lines[i++].replace(/^> ?/, ''));
      const inner = body.map(trimLine).filter((l) => l !== '');
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(inner.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet === null ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < total) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && Number(ordered[1]) !== 1 ? `<ol start="${Number(ordered[1])}">` : `<${tag}>`;
      let html = open + '\n';
      for (let k = 0; k < items.length; k++) html += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
      blocks.push(html + `</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < total && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const html = inline(text, env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
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
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
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
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// The value at `path` in the flat scope object: own properties only.
function lookup(vars, path) {
  let v = vars[path[0]];
  if (v === undefined && !Object.hasOwn(vars, path[0])) return undefined;
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

// The external variable names a template's render can read (its first names
// not bound by an enclosing for), following includes to depth 8. null when a
// cycle makes it unknowable. A template whose names are all among site,
// tags and recent renders the same string every time in a case, so its
// output can be cached.
function externalNames(nodes, templates, bound, depth, seen) {
  const out = new Set();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
    } else if (n.kind === 'if') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      const a = externalNames(n.then, templates, bound, depth, seen);
      if (a === null) return null;
      for (const x of a) out.add(x);
      if (n.else !== null) {
        const b = externalNames(n.else, templates, bound, depth, seen);
        if (b === null) return null;
        for (const x of b) out.add(x);
      }
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      const nb = new Set(bound);
      nb.add(n.name);
      nb.add('loop');
      const a = externalNames(n.body, templates, nb, depth, seen);
      if (a === null) return null;
      for (const x of a) out.add(x);
    } else if (n.kind === 'include') {
      if (depth >= INCLUDE_DEPTH) continue;
      const t = templates.get(n.name);
      if (t === undefined) continue;
      if (seen.has(n.name)) return null;
      const ns = new Set(seen);
      ns.add(n.name);
      const a = externalNames(t, templates, bound, depth + 1, ns);
      if (a === null) return null;
      for (const x of a) out.add(x);
    }
  }
  return out;
}

// `nodes` rendered into the shared `out` array, in the flat scope `vars`.
// A for loop merges its bindings over the parent's vars (loop bindings win),
// which is the same lookup the scope chain gives, without walking it.
// An include of a template that reads only site, tags and recent is served
// from the per-case cache, keyed by name and depth.
function renderNodes(nodes, vars, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const v = lookup(vars, n.path);
        // Numbers and booleans print as digits / true / false, which hold no
        // escapable character, so they skip the escape scan.
        if (typeof v === 'number') out.push(String(v));
        else if (typeof v === 'boolean') out.push(v ? 'true' : 'false');
        else out.push(escapeHtml(textOf(v)));
        break;
      }
      case 'raw':
        out.push(textOf(lookup(vars, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(vars, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, vars, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(vars, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const child = { ...vars, [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        if (ctx.staticSet.has(n.name)) {
          const key = n.name + '' + (depth + 1);
          const hit = ctx.staticCache.get(key);
          if (hit !== undefined) {
            out.push(hit);
            break;
          }
          const tmp = [];
          renderNodes(t, vars, ctx, depth + 1, tmp);
          const s = tmp.join('');
          ctx.staticCache.set(key, s);
          out.push(s);
          break;
        }
        renderNodes(t, vars, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// The words of a body: its runs of characters other than whitespace.
// Counted with the regex engine (no array built, unlike .match()).
function wordsOf(text) {
  let n = 0;
  const re = /\S+/g;
  while (re.exec(text) !== null) n++;
  return n;
}

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

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

export function run(input) {
  // Templates, parsed in code-unit order of name; one that does not parse
  // is reported and left out.
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const broken = new Set();

  // 1. Sources, sorted by path; .md is a source, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in order; refused and draft sources are reported and dropped.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
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
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const slugCache = new Map();
  const slugOf = (name) => {
    let v = slugCache.get(name);
    if (v === undefined) {
      v = slugify(name);
      slugCache.set(name, v);
    }
    return v;
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target[0] === '/' || target[0] === '#') return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags, grouped by slug, named as first met in the posts' order.
  const bySlug = new Map();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const names2 = p.data.tags ?? [];
    const seen = new Set();
    p.tagRefs = [];
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugOf(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names2 = s.data.tags ?? [];
    const seen = new Set();
    s.tagRefs = [];
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugOf(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, one per post, computed once and shared by lists and pages.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));
  const pageCardOf = (s) => {
    let c = cards.get(s);
    if (c === undefined) {
      c = cardOf(s);
      cards.set(s, c);
    }
    return c;
  };
  const pageOf = (s) => {
    const c = pageCardOf(s);
    return {
      ...c,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  // 7. Layouts.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // Templates that read only site, tags and recent (shared by every render
  // in a case) are cached; the rest are rendered fresh each time.
  const staticSet = new Set();
  for (const [name, nodes] of templates) {
    const names = externalNames(nodes, templates, new Set(), 0, new Set([name]));
    if (names !== null) {
      let ok = true;
      for (const x of names) {
        if (x !== 'site' && x !== 'tags' && x !== 'recent') { ok = false; break; }
      }
      if (ok) staticSet.add(name);
    }
  }
  const staticCache = new Map();
  const ctx = { templates, staticSet, staticCache };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { site, tags: allTags, recent, ...vars }, ctx, 0, out);
    return out.join('');
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  }
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
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
