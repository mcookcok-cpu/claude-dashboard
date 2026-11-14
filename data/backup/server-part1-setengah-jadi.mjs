import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 2200);
const DATA = path.join(DIR, 'data');
const VAULT = path.join(DIR, 'vault');
const TRASH = path.join(VAULT, '.trash');
const BACKUP = path.join(DATA, 'backup');
const F_TOKEN = path.join(DATA, 'token.txt');
const F_OLDMEM = path.join(DATA, 'memory.json');
for (const d of [DATA, BACKUP]) fs.mkdirSync(d, { recursive: true });

const TYPES = ['catatan', 'keputusan', 'masalah', 'selesai', 'info', 'sesi', 'proyek', 'harian'];
const STATUSES = ['aktif', 'jeda', 'selesai', 'masalah'];
const FOLDER_BY_TIPE = { proyek: 'Proyek', sesi: 'Sesi', harian: 'Harian' };

class HttpErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const uid = () => crypto.randomBytes(4).toString('hex');
const s = (v, n) => String(v ?? '').trim().slice(0, n);
const nowISO = () => new Date().toISOString();
const wibDate = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
const fmt = ts => ts ? new Date(ts).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }) + ' WIB' : '-';
const slug = n => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const escRe = x => x.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
const safeName = t => String(t).replace(/[\\\/:*?"<>|#^\[\]]/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || 'Tanpa judul';

let TOKEN;
if (fs.existsSync(F_TOKEN)) TOKEN = fs.readFileSync(F_TOKEN, 'utf8').trim();
else { TOKEN = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(F_TOKEN, TOKEN + '\n', { mode: 0o600 }); }

// ---------- FRONTMATTER ----------
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
function unq(v) {
  v = String(v).trim();
  if (v[0] === '"') { try { return JSON.parse(v); } catch {} }
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}
function parseFM(block) {
  const fm = {}; let last = null;
  for (const line of block.split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/))) {
      last = m[1]; const v = m[2].trim();
      if (v === '') fm[last] = '';
      else if (v[0] === '"' || v[0] === "'") fm[last] = unq(v);
      else if (v[0] === '[' && v.endsWith(']')) fm[last] = v.slice(1, -1).split(',').map(x => unq(x)).filter(Boolean);
      else fm[last] = v;
    } else if ((m = line.match(/^\s+-\s+(.*)$/)) && last) {
      if (!Array.isArray(fm[last])) fm[last] = fm[last] ? [fm[last]] : [];
      fm[last].push(unq(m[1]));
    }
  }
  return fm;
}
const needsQuote = v => /^[\s\-?:,\[\]{}#&*!|>'"%@`]|:\s|\s#|\s$|^$/.test(v);
const ser = v => Array.isArray(v) ? '[' + v.join(', ') + ']' : (needsQuote(String(v)) ? JSON.stringify(String(v)) : String(v));
function setFM(txt, key, val) {
  const line = key + ': ' + (val === null ? '' : ser(val));
  const m = txt.match(FM_RE);
  if (!m) return val === null ? txt : '---\n' + line + '\n---\n' + txt;
  const lines = m[1].split(/\r?\n/), out = []; let found = false;
  const kre = new RegExp('^' + escRe(key) + ':');
  for (let i = 0; i < lines.length; i++) {
    if (kre.test(lines[i])) {
      found = true; if (val !== null) out.push(line);
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) i++;
    } else out.push(lines[i]);
  }
  if (!found && val !== null) out.push(line);
  return '---\n' + out.join('\n') + '\n---\n' + txt.slice(m[0].length);
}

// ---------- VAULT: SCAN, TAUTAN, TAG ----------
const WL = /\[\[([^\]\|#\n]+?)(?:#([^\]\|\n]*))?(?:\|([^\]\n]*))?\]\]/g;
const TAGRE = /(^|[\s(])#([\p{L}\p{N}_\/-]*\p{L}[\p{L}\p{N}_\/-]*)/gmu;
const TASKRE = /^(\s*[-*+]\s+\[)( |x|X)(\]\s+)(.*?)(?:\s+\^(t-[\w]+))?\s*$/;
const stripCode = t => t.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');

const cache = new Map();
function walk(dir, rel, out) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue;
    const r = rel ? rel + '/' + d.name : d.name;
    if (d.isDirectory()) walk(path.join(dir, d.name), r, out);
    else if (d.isFile() && d.name.endsWith('.md')) out.push(r);
  }
}
function parseNote(rel, raw, st) {
  const m = raw.match(FM_RE);
  const fm = m ? parseFM(m[1]) : {};
  const body = m ? raw.slice(m[0].length) : raw;
  const tags = new Set();
  for (const x of stripCode(body).matchAll(TAGRE)) tags.add(x[2].toLowerCase());
  if (fm.tags) for (const t of (Array.isArray(fm.tags) ? fm.tags : String(fm.tags).split(/[,\s]+/))) { const tt = String(t).replace(/^#/, '').trim().toLowerCase(); if (tt) tags.add(tt); }
  const rawLinks = [...stripCode(raw).matchAll(WL)].map(x => x[1].trim());
  const excerpt = body.replace(/```[\s\S]*?```/g, '').replace(/^\s*#{1,6}\s.*$/gm, '').replace(/[#>*_`\[\]=|]/g, '').replace(/\^t-\w+/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return { mtimeMs: st.mtimeMs, size: st.size, raw, fm, tags, rawLinks, excerpt, title: path.basename(rel, '.md') };
}
function listVault() {
  const files = []; walk(VAULT, '', files);
  const seen = new Set();
  for (const rel of files) {
    const st = fs.statSync(path.join(VAULT, rel)); seen.add(rel);
    const c = cache.get(rel);
    if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
      let raw = ''; try { raw = fs.readFileSync(path.join(VAULT, rel), 'utf8').slice(0, 400000); } catch {}
      cache.set(rel, parseNote(rel, raw, st));
    }
  }
  for (const k of [...cache.keys()]) if (!seen.has(k)) cache.delete(k);
  const byTitle = new Map(), byPath = new Map();
  for (const rel of files) {
    const t = path.basename(rel, '.md').toLowerCase(), cur = byTitle.get(t);
    if (!cur || rel.length < cur.length) byTitle.set(t, rel);
    byPath.set(rel.slice(0, -3).toLowerCase(), rel);
  }
  const resolve = name => { const k = String(name).trim().toLowerCase().replace(/\.md$/, ''); return byPath.get(k) || byTitle.get(k) || null; };
  const notes = [], tags = {};
  for (const rel of files) {
    const c = cache.get(rel), links = new Set(); let unresolved = 0;
    for (const l of c.rawLinks) { const r = resolve(l); if (r && r !== rel) links.add(r); else if (!r) unresolved++; }
    for (const t of c.tags) tags[t] = (tags[t] || 0) + 1;
    notes.push({ path: rel, title: c.title, folder: rel.includes('/') ? rel.split('/')[0] : '', mtime: c.mtimeMs, size: c.size, tipe: c.fm.tipe || null, status: c.fm.status || null, tags: [...c.tags], links: [...links], unresolved, excerpt: c.excerpt });
  }
  return { notes, tags, resolve };
}

// ---------- FILE OPS ----------
function vp(rel) {
  if (typeof rel !== 'string' || !rel) throw new HttpErr(400, 'path kosong');
  rel = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel.endsWith('.md')) throw new HttpErr(400, 'harus berakhiran .md');
  const parts = rel.split('/');
  if (parts.length > 4 || parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) throw new HttpErr(400, 'path tidak valid');
  const full = path.join(VAULT, rel);
  if (!full.startsWith(VAULT + path.sep)) throw new HttpErr(400, 'path tidak valid');
  return full;
}
function readNote(rel) {
  const full = vp(rel);
  if (!fs.existsSync(full)) throw new HttpErr(404, 'catatan tidak ditemukan');
  const st = fs.statSync(full);
  return { raw: fs.readFileSync(full, 'utf8'), mtime: st.mtimeMs };
}
function writeAtomic(full, content, when) {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = path.join(path.dirname(full), '.' + path.basename(full) + '.tmp');
  fs.writeFileSync(tmp, content); fs.renameSync(tmp, full);
  if (when && !isNaN(when)) fs.utimesSync(full, when, when);
  return fs.statSync(full).mtimeMs;
}
function uniqueRel(folder, title) {
  const base = safeName(title), pre = folder ? folder + '/' : '';
  let rel = pre + base + '.md', n = 2;
  while (fs.existsSync(path.join(VAULT, rel))) rel = pre + base + ' ' + (n++) + '.md';
  return rel;
}
function bodyTemplate(tipe, o) {
  switch (tipe) {
    case 'keputusan': return '**Keputusan:** \n\n**Alasan:** \n';
    case 'masalah': return '**Masalah:** \n\n**Dugaan penyebab:** \n\n**Langkah dicoba:** \n';
    case 'selesai': return '**Yang selesai:** \n\n**Hasil/cara cek:** \n';
    case 'sesi': return '## Yang sudah dikerjakan\n- \n\n## Belum selesai\n- [ ] \n\n## Langkah berikutnya\n1. \n\n## Konteks penting\n- \n';
    case 'proyek': return '(ringkasan proyek)\n\n## Tugas\n\n';
    case 'harian': return '## Catatan\n\n## Tugas hari ini\n- [ ] \n\n## Jurnal\n';
    default: return '';
  }
}
function createNote(o) {
  const tipe = TYPES.includes(o.tipe) ? o.tipe : 'catatan';
  const folder = o.folder !== undefined ? o.folder : (FOLDER_BY_TIPE[tipe] || 'Catatan');
  const rel = uniqueRel(folder, o.title || 'Tanpa judul');
  const L = ['tipe: ' + tipe];
  if (tipe === 'proyek') {
    L.push('id: ' + (o.id || slug(o.title) || uid()), 'status: ' + (STATUSES.includes(o.status) ? o.status : 'aktif'));
    if (o.port) L.push('port: ' + ser(o.port));
    if (o.lokasi) L.push('lokasi: ' + ser(o.lokasi));
  }
  if (o.proyekRel) L.push('proyek: ' + ser('[[' + path.basename(o.proyekRel, '.md') + ']]'));
  L.push('oleh: ' + ser(o.oleh || 'claude'), 'dibuat: ' + (o.ts || nowISO()));
  if (tipe === 'proyek') L.push('diperbarui: ' + (o.updated || o.ts || nowISO()));
  if (o.tags && o.tags.length) L.push('tags: [' + o.tags.join(', ') + ']');
  const body = o.body !== undefined ? o.body : bodyTemplate(tipe, o);
  const mt = writeAtomic(path.join(VAULT, rel), '---\n' + L.join('\n') + '\n---\n' + body.replace(/\s+$/, '') + '\n', new Date(o.updated || o.ts || Date.now()));
  return { path: rel, mtime: mt };
}
function renameNote(rel, newTitle) {
  if (rel === 'HANDOFF.md') throw new HttpErr(403, 'HANDOFF.md dibuat otomatis');
  const from = vp(rel), oldT = path.basename(rel, '.md'), nt = safeName(newTitle);
  const dir = path.dirname(rel) === '.' ? '' : path.dirname(rel);
  const to = (dir ? dir + '/' : '') + nt + '.md';
  if (to === rel) return { path: rel };
  if (fs.existsSync(vp(to))) throw new HttpErr(409, 'nama sudah dipakai');
  fs.renameSync(from, vp(to)); cache.delete(rel);
  const re = new RegExp('\\[\\[\\s*' + escRe(oldT) + '(\\s*(?:[#|][^\\]\\n]*)?)\\]\\]', 'gi');
  for (const n of listVault().notes) {
    const c = cache.get(n.path);
    if (!c.raw.toLowerCase().includes('[[' + oldT.toLowerCase())) continue;
    const upd = c.raw.replace(re, (m, g1) => '[[' + nt + g1 + ']]');
    if (upd !== c.raw) writeAtomic(vp(n.path), upd);
  }
  return { path: to };
}
function trashNote(rel) {
  if (rel === 'HANDOFF.md') throw new HttpErr(403, 'HANDOFF.md dibuat otomatis');
  const full = vp(rel);
  if (!fs.existsSync(full)) throw new HttpErr(404, 'catatan tidak ditemukan');
  fs.mkdirSync(TRASH, { recursive: true });
  fs.renameSync(full, path.join(TRASH, Date.now() + '-' + path.basename(rel)));
}

// ---------- PROYEK, TUGAS (dipakai CLI) ----------
function findProject(ref) {
  if (!ref) return null;
  const r = String(ref).trim().toLowerCase();
  for (const n of listVault().notes) {
    if (n.tipe !== 'proyek') continue;
    const c = cache.get(n.path);
    if (String(c.fm.id || '').toLowerCase() === r || n.title.toLowerCase() === r || slug(n.title) === r) return n.path;
  }
  return null;
}
function getSummary(raw) {
  const m = raw.match(FM_RE), body = m ? raw.slice(m[0].length) : raw;
  const lines = body.split('\n'), k = lines.findIndex(l => /^##\s/.test(l));
  return (k < 0 ? lines : lines.slice(0, k)).join(' ').replace(/^\s*#\s.*?(?=\s|$)/, '').replace(/\s+/g, ' ').trim().slice(0, 300);
}
function setSummary(raw, text) {
  const m = raw.match(FM_RE), head = m ? m[0] : '', body = raw.slice(head.length);
  const lines = body.split('\n'), k = lines.findIndex(l => /^##\s/.test(l));
  const rest = k < 0 ? '' : lines.slice(k).join('\n');
  return head + text.trim() + '\n\n' + rest + (rest.endsWith('\n') || !rest ? '' : '\n');
}
function tasksOf(raw) {
  return raw.split('\n').map((ln, i) => { const m = ln.match(TASKRE); return m ? { line: i + 1, done: m[2] !== ' ', text: m[4], id: m[5] || null } : null; }).filter(Boolean);
}
function addTask(rel, text) {
  let { raw } = readNote(rel);
  const id = 't-' + uid(), line = '- [ ] ' + text.replace(/\s+/g, ' ').trim() + ' ^' + id;
  const lines = raw.split('\n'), h = lines.findIndex(l => /^##\s+Tugas\s*$/i.test(l));
  if (h < 0) { while (lines.length && lines[lines.length - 1] === '') lines.pop(); lines.push('', '## Tugas', line, ''); }
  else { let k = h + 1, last = h; while (k < lines.length && !/^#{1,6}\s/.test(lines[k])) { if (TASKRE.test(lines[k])) last = k; k++; } lines.splice(last + 1, 0, line); }
  raw = setFM(lines.join('\n'), 'diperbarui', nowISO());
  writeAtomic(vp(rel), raw);
  return id;
}
function toggleTask(ref) {
  ref = String(ref || '');
  let rel, idx;
  if (/^t-[\w]+$/.test(ref)) {
    for (const n of listVault().notes) {
      const lines = cache.get(n.path).raw.split('\n'), i = lines.findIndex(l => l.includes('^' + ref) && TASKRE.test(l));
      if (i >= 0) { rel = n.path; idx = i; break; }
    }
  } else { const m = ref.match(/^(.+\.md):(\d+)$/); if (m) { rel = m[1]; idx = Number(m[2]) - 1; } }
  if (rel === undefined) throw new HttpErr(404, 'tugas tidak ditemukan');
  if (rel === 'HANDOFF.md') throw new HttpErr(403, 'HANDOFF.md dibuat otomatis');
  const { raw } = readNote(rel), lines = raw.split('\n');
  if (!TASKRE.test(lines[idx] || '')) throw new HttpErr(404, 'baris itu bukan tugas');
  lines[idx] = lines[idx].replace(/\[( |x|X)\]/, (m, c) => c === ' ' ? '[x]' : '[ ]');
  writeAtomic(vp(rel), lines.join('\n'));
  const t = lines[idx].match(TASKRE);
  return { path: rel, done: t[2] !== ' ', text: t[4] };
}
function upsertProject(b) {
  const name = s(b.name, 80), id = s(b.id, 60) || slug(name);
  let rel = findProject(id) || (name ? findProject(name) : null);
  if (!rel) {
    if (!name) throw new HttpErr(400, 'nama wajib diisi');
    return createNote({ title: name, tipe: 'proyek', id: id || slug(name), status: b.status, lokasi: s(b.path, 200), port: s(b.port, 20), body: (b.summary ? s(b.summary, 1000) : '(ringkasan proyek)') + '\n\n## Tugas\n\n' });
  }
  if (name && name !== path.basename(rel, '.md')) rel = renameNote(rel, name).path;
  let { raw } = readNote(rel);
  if (STATUSES.includes(b.status)) raw = setFM(raw, 'status', b.status);
  if (b.path !== undefined) raw = setFM(raw, 'lokasi', s(b.path, 200));
  if (b.port !== undefined) raw = setFM(raw, 'port', s(b.port, 20));
  if (b.summary !== undefined) raw = setSummary(raw, s(b.summary, 1000));
  raw = setFM(raw, 'diperbarui', nowISO());
  return { path: rel, mtime: writeAtomic(vp(rel), raw) };
}
function touchProject(rel) {
  try { const { raw } = readNote(rel); writeAtomic(vp(rel), setFM(raw, 'diperbarui', nowISO())); } catch {}
}
