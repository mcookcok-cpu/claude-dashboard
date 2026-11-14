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
const shortTitle = (t, n = 48) => { t = String(t).replace(/\s+/g, ' ').trim(); if (t.length <= n) return t; const cut = t.slice(0, n), i = cut.lastIndexOf(' '); return (i > 20 ? cut.slice(0, i) : cut).replace(/[.,;:\-\s]+$/, ''); };
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

// ---------- SISTEM ----------
function readCpu() {
  const l = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  return { idle: l[3] + (l[4] || 0), total: l.reduce((a, b) => a + b, 0) };
}
let cpuPct = 0, prevCpu = readCpu();
setInterval(() => {
  try { const c = readCpu(); const dt = c.total - prevCpu.total, di = c.idle - prevCpu.idle; if (dt > 0) cpuPct = Math.round((1 - di / dt) * 1000) / 10; prevCpu = c; } catch {}
}, 2000);
let diskCache = { t: 0, v: null };
function getDisk() {
  if (Date.now() - diskCache.t < 30000 && diskCache.v) return Promise.resolve(diskCache.v);
  return new Promise(resolve => {
    execFile('df', ['-kP', '/'], { timeout: 5000 }, (err, out) => {
      if (!err) {
        const f = out.trim().split('\n')[1]?.trim().split(/\s+/);
        if (f && f.length >= 5) diskCache = { t: Date.now(), v: { size: f[1] * 1024, used: f[2] * 1024, avail: f[3] * 1024, pct: parseInt(f[4]) } };
      }
      resolve(diskCache.v);
    });
  });
}
async function getSystem() {
  const mi = fs.readFileSync('/proc/meminfo', 'utf8');
  const g = k => Number((mi.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')) || [])[1] || 0) * 1024;
  const total = g('MemTotal'), avail = g('MemAvailable'), swT = g('SwapTotal'), swF = g('SwapFree');
  return { cpu: cpuPct, cores: os.cpus().length, load: os.loadavg().map(x => Math.round(x * 100) / 100), ram: { total, used: total - avail, avail }, swap: { total: swT, used: swT - swF }, disk: await getDisk(), uptime: os.uptime(), time: Date.now() };
}
let pm2Cache = { t: 0, v: [] };
function getPm2() {
  if (Date.now() - pm2Cache.t < 4000) return Promise.resolve(pm2Cache.v);
  return new Promise(resolve => {
    execFile(process.env.PM2_BIN || 'pm2', ['jlist'], { timeout: 8000, maxBuffer: 8e6 }, (err, out) => {
      if (!err) {
        try {
          const i = out.indexOf('[');
          const arr = JSON.parse(out.slice(i, out.lastIndexOf(']') + 1));
          pm2Cache = { t: Date.now(), v: arr.map(a => ({ id: a.pm_id, name: a.name, status: a.pm2_env?.status, uptime: a.pm2_env?.pm_uptime ? Date.now() - a.pm2_env.pm_uptime : 0, restarts: a.pm2_env?.restart_time, mem: a.monit?.memory, cpu: a.monit?.cpu, pid: a.pid })) };
        } catch {}
      }
      resolve(pm2Cache.v);
    });
  });
}
function localIPs() {
  const r = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) r.push(i.address);
  return r;
}

// ---------- PANDUAN & MIGRASI ----------
function guideText(projTitles) {
  return `# Panduan Vault

Ini vault catatan ala Obsidian. Setiap catatan adalah file Markdown biasa di folder \`vault/\`, jadi agent Claude juga bisa membaca dan menulisnya langsung.

## Dasar
- Tautan antar catatan: tulis \`[[Nama Catatan]]\` atau \`[[Nama Catatan|teks lain]]\`. Tautan yang belum ada tampil redup, ketuk untuk membuatnya.
- Tag: tulis \`#tag\` di mana saja, atau \`tags: [a, b]\` di properti.
- Tugas: \`- [ ] tugas\`, ketuk kotaknya untuk mencentang.
- Tautan balik: di bawah tiap catatan ada daftar catatan lain yang menautkannya.
- Catatan harian: tab Harian membuat catatan tanggal hari ini.
- Graf: tab Graf menampilkan peta semua catatan. Ketuk titik untuk melihat tetangganya, ketuk lagi untuk membukanya.

## Pencarian
- Kata biasa: cari di judul dan isi.
- \`tag:proyek\`, \`tipe:sesi\`, \`path:Harian\`, \`status:aktif\`: saring.
- Tanda kutip untuk frasa: \`"pm2 save"\`.

## Proyek
${projTitles.length ? projTitles.map(t => '- [[' + t + ']]').join('\n') : '(belum ada proyek)'}

## Untuk agent
Baca [HANDOFF.md](HANDOFF.md) dulu. Catat lewat \`cm.mjs\` (note, task, done, daily, append, search, read).

#panduan
`;
}
function migrate() {
  fs.mkdirSync(VAULT, { recursive: true });
  if (fs.readdirSync(VAULT).some(f => !f.startsWith('.'))) return false;
  let old = { projects: [], notes: [], tasks: [] };
  try { old = JSON.parse(fs.readFileSync(F_OLDMEM, 'utf8')); } catch {}
  const bak = path.join(BACKUP, 'memory-sebelum-vault.json');
  if (fs.existsSync(F_OLDMEM) && !fs.existsSync(bak)) fs.copyFileSync(F_OLDMEM, bak);
  const pmap = {}, titles = [];
  for (const p of old.projects || []) {
    const ts = (old.tasks || []).filter(t => t.projectId === p.id);
    const lines = ts.map(t => '- [' + (t.done ? 'x' : ' ') + '] ' + String(t.text).replace(/\s+/g, ' ') + ' ^t-' + String(t.id).replace(/[^\w]/g, ''));
    const body = (p.summary || '(ringkasan proyek)') + '\n\n## Tugas\n' + lines.join('\n') + '\n';
    const r = createNote({ title: p.name, tipe: 'proyek', id: p.id, status: p.status, port: p.port, lokasi: p.path, ts: p.createdAt, updated: p.updatedAt, body });
    pmap[p.id] = r.path; titles.push(path.basename(r.path, '.md'));
  }
  for (const n of old.notes || []) {
    const first = String(n.text || '').split('\n')[0].replace(/[#*`\[\]^]/g, '').trim();
    createNote({ title: wibDate(new Date(n.ts)) + ' ' + (shortTitle(first) || n.type), tipe: n.type, oleh: n.by, ts: n.ts, proyekRel: pmap[n.projectId], body: n.text });
  }
  createNote({ title: 'Panduan', tipe: 'catatan', folder: '', tags: ['panduan'], body: guideText(titles).replace(/\n#panduan\n$/, '\n') });
  return true;
}

// ---------- HANDOFF ----------
const F_HANDOFF_VAULT = path.join(VAULT, 'HANDOFF.md');
const F_HANDOFF_DATA = path.join(DATA, 'HANDOFF.md');
const bodyOf = raw => { const m = raw.match(FM_RE); return (m ? raw.slice(m[0].length) : raw).trim(); };
const clip = (t, n) => t.length > n ? t.slice(0, n).trimEnd() + '…' : t;
function buildHandoff() {
  const { notes } = listVault();
  const cm = 'node ' + path.join(DIR, 'cm.mjs');
  const real = notes.filter(n => n.path !== 'HANDOFF.md');
  const L = ['---', 'tipe: handoff', 'otomatis: true', '---', '# HANDOFF — Pusat Komando Claude', '> Dibuat otomatis dari vault. Terakhir diperbarui: ' + fmt(Date.now()), ''];
  L.push('## Mulai dari sini (untuk agent Claude berikutnya)');
  L.push('1. Baca seluruh file ini sebelum bertindak.', '2. Cek server: `pm2 list`', '3. Lanjutkan tugas yang masih terbuka di bagian Proyek.');
  L.push('4. Catat progres setiap langkah penting:');
  L.push('   - `' + cm + ' note "teks" --proyek <id> --tipe keputusan|catatan|masalah|selesai|info|sesi`');
  L.push('   - `' + cm + ' task <id-proyek> "tugas baru"`  dan  `' + cm + ' done <id-tugas>`');
  L.push('   - `' + cm + ' list` melihat proyek, tugas terbuka, dan id-nya');
  L.push('   - `' + cm + ' daily "teks"` menambah baris ke catatan harian hari ini');
  L.push('   - `' + cm + ' search kata` dan `' + cm + ' read "Folder/Judul.md"`');
  L.push('5. Sebelum berhenti atau kena limit, tulis satu catatan `--tipe sesi`: apa yang sudah dikerjakan, apa yang belum, dan langkah berikutnya.');
  L.push('6. Jangan hentikan pm2 `mcp-server` dan `mcp-ngrok` (jalur akses agent ke VM ini).');
  L.push('7. Balas dalam bahasa Indonesia, ringkas (pengguna memakai HP).');
  L.push('8. Catatan disimpan sebagai file Markdown di `' + VAULT + '` (gaya Obsidian: `[[tautan]]`, `#tag`). Boleh dibaca langsung.', '');
  L.push('## Server');
  const pm = pm2Cache.v || [];
  L.push('- pm2: ' + (pm.length ? pm.map(p => p.name + ' (' + p.status + ')').join(', ') : '(belum terbaca)'));
  L.push('- Dashboard: port ' + PORT + ', folder `' + DIR + '`, file ini: `' + F_HANDOFF_DATA + '`');
  L.push('- Alamat: ' + (localIPs().map(i => 'http://' + i + ':' + PORT).join(' , ') || '-'), '');
  L.push('## Proyek');
  const projects = real.filter(n => n.tipe === 'proyek');
  if (!projects.length) L.push('(belum ada proyek tercatat)');
  for (const p of projects) {
    const c = cache.get(p.path), id = c.fm.id || slug(p.title);
    const ts = tasksOf(c.raw).filter(t => t.text.trim());
    const open = ts.filter(t => !t.done), done = ts.filter(t => t.done).slice(-5);
    const rel = real.filter(n => n.tipe !== 'proyek' && n.links.includes(p.path)).sort((a, b) => b.mtime - a.mtime).slice(0, 5);
    L.push('', '### ' + p.title + ' (`' + id + '`) — ' + (p.status || 'aktif'));
    const sm = getSummary(c.raw); if (sm) L.push('- Ringkasan: ' + sm);
    if (c.fm.lokasi) L.push('- Lokasi: `' + c.fm.lokasi + '`');
    if (c.fm.port) L.push('- Port: ' + c.fm.port);
    L.push('- Diperbarui: ' + fmt(c.fm.diperbarui || p.mtime));
    L.push('- Tugas terbuka:' + (open.length ? '' : ' tidak ada'));
    for (const t of open) L.push('  - [ ] ' + t.text + (t.id ? ' (`' + t.id + '`)' : ''));
    if (done.length) { L.push('- Selesai terakhir:'); for (const t of done) L.push('  - [x] ' + t.text); }
    if (rel.length) { L.push('- Catatan terakhir:'); for (const n of rel) L.push('  - [' + (n.tipe || 'catatan') + '] ' + fmt(n.mtime) + ' — ' + clip(bodyOf(cache.get(n.path).raw).replace(/\s+/g, ' '), 400) + ' (`' + n.path + '`)'); }
  }
  const lose = real.filter(n => n.tipe !== 'proyek' && n.tipe !== 'harian' && !n.links.some(l => projects.some(p => p.path === l))).sort((a, b) => b.mtime - a.mtime).slice(0, 10);
  L.push('', '## Catatan umum (tanpa proyek)');
  if (!lose.length) L.push('(tidak ada)');
  for (const n of lose) L.push('- [' + (n.tipe || 'catatan') + '] ' + fmt(n.mtime) + ' — ' + n.title + ': ' + clip(bodyOf(cache.get(n.path).raw).replace(/\s+/g, ' '), 300) + ' (`' + n.path + '`)');
  const sesi = real.filter(n => n.tipe === 'sesi').sort((a, b) => b.mtime - a.mtime).slice(0, 3);
  if (sesi.length) { L.push('', '## Sesi terakhir'); for (const n of sesi) L.push('', '### ' + n.title + ' (' + fmt(n.mtime) + ')', clip(bodyOf(cache.get(n.path).raw), 1500)); }
  L.push('', '## Catatan terbaru (20)');
  for (const n of [...real].sort((a, b) => b.mtime - a.mtime).slice(0, 20)) L.push('- ' + fmt(n.mtime) + ' — `' + n.path + '`');
  return L.join('\n') + '\n';
}
function writeHandoff() {
  try { const t = buildHandoff(); writeAtomic(F_HANDOFF_VAULT, t); fs.writeFileSync(F_HANDOFF_DATA, t.replace(/^---\n[\s\S]*?\n---\n/, '')); } catch (e) { console.error('handoff gagal:', e.message); }
}
let hoTimer = null;
const markDirty = () => { clearTimeout(hoTimer); hoTimer = setTimeout(writeHandoff, 600); };
const stampOf = notes => { let mx = 0, c = 0; for (const n of notes) if (n.path !== 'HANDOFF.md') { c++; if (n.mtime > mx) mx = n.mtime; } return c + ':' + Math.round(mx); };
let lastStamp = '', lastBackupStamp = '';
setInterval(() => { try { const st = stampOf(listVault().notes); if (st !== lastStamp) { lastStamp = st; writeHandoff(); } } catch {} }, 30000);
setInterval(() => {
  try {
    const st = stampOf(listVault().notes); if (st === lastBackupStamp) return; lastBackupStamp = st;
    const out = path.join(BACKUP, 'vault-' + nowISO().replace(/[:.]/g, '-') + '.tgz');
    execFile('tar', ['czf', out, '-C', DIR, 'vault'], { timeout: 30000 }, err => {
      if (err) return console.error('backup gagal:', err.message);
      const old = fs.readdirSync(BACKUP).filter(f => /^vault-.*\.tgz$/.test(f)).sort();
      while (old.length > 20) fs.unlinkSync(path.join(BACKUP, old.shift()));
    });
  } catch {}
}, 600000);

// ---------- CARI, TUGAS, HARIAN ----------
function snippetFor(raw, rel, resolve) {
  for (const ln of bodyOf(raw).split('\n')) {
    for (const m of ln.matchAll(WL)) if (resolve(m[1]) === rel) return clip(ln.trim(), 180);
  }
  return '';
}
function search(qstr, limit = 40) {
  const { notes } = listVault();
  const terms = [], F = { tag: [], path: [], tipe: [], status: [] };
  for (const m of String(qstr || '').matchAll(/"([^"]+)"|(\S+)/g)) {
    const tok = m[1] || m[2], fm = !m[1] && tok.match(/^(tag|path|tipe|status):(.+)$/i);
    if (fm) F[fm[1].toLowerCase()].push(fm[2].toLowerCase().replace(/^#/, ''));
    else if (!m[1] && /^#[\p{L}\p{N}_\/-]+$/u.test(tok)) F.tag.push(tok.slice(1).toLowerCase());
    else terms.push(tok.toLowerCase());
  }
  const out = [];
  for (const n of notes) {
    if (F.tag.length && !F.tag.every(t => n.tags.some(x => x === t || x.startsWith(t + '/')))) continue;
    if (F.path.length && !F.path.every(p => n.path.toLowerCase().includes(p))) continue;
    if (F.tipe.length && !F.tipe.every(t => (n.tipe || '').toLowerCase() === t)) continue;
    if (F.status.length && !F.status.every(t => (n.status || '').toLowerCase() === t)) continue;
    const c = cache.get(n.path), body = bodyOf(c.raw), low = body.toLowerCase(), tl = n.title.toLowerCase(), pl = n.path.toLowerCase();
    let score = 0, ok = true, first = -1;
    for (const t of terms) {
      let sc = 0;
      if (tl === t) sc += 30; else if (tl.startsWith(t)) sc += 15; else if (tl.includes(t)) sc += 10;
      if (pl.includes(t)) sc += 2;
      const i = low.indexOf(t);
      if (i >= 0) { sc += 1 + Math.min(4, low.split(t).length - 2); if (first < 0) first = i; }
      if (!sc) { ok = false; break; }
      score += sc;
    }
    if (!ok) continue;
    let snippet = n.excerpt;
    if (first >= 0) { const a = Math.max(0, first - 50); snippet = (a ? '…' : '') + body.slice(a, first + 130).replace(/\s+/g, ' ').trim(); }
    out.push({ path: n.path, title: n.title, tipe: n.tipe, mtime: n.mtime, tags: n.tags, snippet, score });
  }
  out.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  return out.slice(0, limit);
}
function allTasks() {
  const out = [];
  for (const n of listVault().notes) {
    if (n.path === 'HANDOFF.md') continue;
    for (const t of tasksOf(cache.get(n.path).raw)) if (t.text.trim()) out.push({ path: n.path, title: n.title, tipe: n.tipe, line: t.line, done: t.done, text: t.text, id: t.id, mtime: n.mtime });
  }
  return out;
}
function ensureDaily(date) {
  date = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : wibDate();
  const rel = 'Harian/' + date + '.md';
  if (!fs.existsSync(vp(rel))) createNote({ title: date, tipe: 'harian', tags: ['harian'], folder: 'Harian' });
  return rel;
}
function cleanFolder(f) {
  return String(f || '').split('/').map(x => safeName(x)).filter(x => x && x !== 'Tanpa judul').slice(0, 2).join('/');
}
function appendTo(rel, text) {
  const { raw } = readNote(rel);
  const t = String(text).replace(/\s+$/, '');
  if (!t) throw new HttpErr(400, 'teks kosong');
  let out = raw.replace(/\s*$/, '\n') + t + '\n';
  const fm = cache.get(rel)?.fm;
  if (fm && fm.tipe === 'proyek') out = setFM(out, 'diperbarui', nowISO());
  return writeAtomic(vp(rel), out);
}

// ---------- HTTP ----------
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
function readJSON(req, limit = 1500000) {
  return new Promise((resolve, reject) => {
    let b = '', n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new HttpErr(413, 'terlalu besar')); req.destroy(); return; } b += c; });
    req.on('end', () => { if (!b) return resolve({}); try { resolve(JSON.parse(b)); } catch { reject(new HttpErr(400, 'JSON tidak valid')); } });
  });
}
function authed(req, url) {
  const k = req.headers['x-key'] || url.searchParams.get('key');
  if (!k) return false;
  const a = Buffer.from(String(k)), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1e1e1e"/><path d="M32 10 46 18v16L32 54 18 34V18z" fill="none" stroke="#a88bfa" stroke-width="4" stroke-linejoin="round"/><path d="M32 10v44M18 18l28 16M46 18 18 34" stroke="#a88bfa" stroke-width="2.5" opacity=".7"/></svg>';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname, q = url.searchParams, M = req.method;
  try {
    if (M === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(DIR, 'public/index.html')));
    }
    if (p === '/healthz') return json(res, 200, { ok: true });
    if (p === '/icon.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' }); return res.end(ICON); }
    if (p === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json' });
      return res.end(JSON.stringify({ name: 'Vault Claude', short_name: 'Vault', start_url: '/', display: 'standalone', background_color: '#1e1e1e', theme_color: '#1e1e1e', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] }));
    }
    if (!(p.startsWith('/api/') || p === '/handoff.md')) return json(res, 404, { error: 'tidak ditemukan' });
    if (!authed(req, url)) return json(res, 401, { error: 'kunci salah' });

    if (M === 'GET' && p === '/handoff.md') {
      await getPm2(); writeHandoff();
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(F_HANDOFF_DATA, 'utf8'));
    }
    if (M === 'GET' && p === '/api/system') {
      const [sys, pm2] = await Promise.all([getSystem(), getPm2()]);
      return json(res, 200, { meta: { dir: DIR, vault: VAULT, home: os.homedir(), host: os.hostname(), ips: localIPs(), port: PORT }, sys, pm2 });
    }
    if (M === 'GET' && p === '/api/vault') {
      const v = listVault();
      return json(res, 200, { notes: v.notes, tags: v.tags, stamp: stampOf(v.notes), meta: { dir: DIR, vault: VAULT, port: PORT, today: wibDate(), ips: localIPs() } });
    }
    if (M === 'GET' && p === '/api/note') {
      const rel = q.get('path'), { raw, mtime } = readNote(rel), v = listVault();
      const me = v.notes.find(n => n.path === rel), backlinks = [];
      for (const n of v.notes) if (n.path !== rel && n.links.includes(rel)) backlinks.push({ path: n.path, title: n.title, tipe: n.tipe, mtime: n.mtime, snippet: snippetFor(cache.get(n.path).raw, rel, v.resolve) });
      backlinks.sort((a, b) => b.mtime - a.mtime);
      const unresolved = [...new Set(cache.get(rel).rawLinks.filter(l => !v.resolve(l)))];
      const links = (me ? me.links : []).map(l => ({ path: l, title: path.basename(l, '.md') }));
      return json(res, 200, { path: rel, title: path.basename(rel, '.md'), raw, mtime, backlinks, links, unresolved });
    }
    if (M === 'PUT' && p === '/api/note') {
      const b = await readJSON(req), rel = b.path;
      if (rel === 'HANDOFF.md') throw new HttpErr(403, 'HANDOFF.md dibuat otomatis');
      const full = vp(rel);
      if (typeof b.raw !== 'string') throw new HttpErr(400, 'isi kosong');
      if (fs.existsSync(full) && b.mtime && !b.force) {
        const cur = fs.statSync(full).mtimeMs;
        if (Math.abs(cur - b.mtime) > 1) return json(res, 409, { error: 'catatan diubah di tempat lain', mtime: cur, raw: fs.readFileSync(full, 'utf8') });
      }
      const mt = writeAtomic(full, b.raw); markDirty();
      return json(res, 200, { mtime: mt });
    }
    if (M === 'DELETE' && p === '/api/note') { trashNote(q.get('path')); markDirty(); return json(res, 200, { ok: true }); }
    if (M === 'POST' && p === '/api/new') {
      const b = await readJSON(req);
      const title = s(b.title, 80);
      if (!title) throw new HttpErr(400, 'judul wajib diisi');
      const tipe = TYPES.includes(b.tipe) ? b.tipe : 'catatan';
      const o = { title, tipe, oleh: s(b.oleh, 40) || 'pengguna' };
      if (b.folder !== undefined) o.folder = cleanFolder(b.folder);
      if (typeof b.body === 'string') o.body = b.body;
      if (Array.isArray(b.tags)) o.tags = b.tags.map(t => String(t).replace(/[^\p{L}\p{N}_\/-]/gu, '')).filter(Boolean);
      if (b.proyek) o.proyekRel = findProject(b.proyek) || undefined;
      const r = createNote(o); markDirty();
      return json(res, 200, r);
    }
    if (M === 'POST' && p === '/api/rename') {
      const b = await readJSON(req); vp(b.path);
      const r = renameNote(b.path, s(b.title, 80)); markDirty();
      return json(res, 200, r);
    }
    if (M === 'POST' && p === '/api/daily') {
      const b = await readJSON(req); return json(res, 200, { path: ensureDaily(b.date) });
    }
    if (M === 'POST' && p === '/api/append') {
      const b = await readJSON(req);
      const rel = b.path === 'daily' ? ensureDaily(b.date) : b.path;
      if (rel === 'HANDOFF.md') throw new HttpErr(403, 'HANDOFF.md dibuat otomatis');
      vp(rel); const mt = appendTo(rel, s(b.text, 5000)); markDirty();
      return json(res, 200, { path: rel, mtime: mt });
    }
    if (M === 'GET' && p === '/api/search') return json(res, 200, { results: search(q.get('q') || '', Number(q.get('limit')) || 40) });
    if (M === 'GET' && p === '/api/tasks') return json(res, 200, { tasks: allTasks() });
    if (M === 'POST' && p === '/api/task/toggle') {
      const b = await readJSON(req), r = toggleTask(b.ref);
      const c = cache.get(r.path); if (c && c.fm.tipe === 'proyek') touchProject(r.path);
      markDirty(); return json(res, 200, r);
    }
    if (M === 'GET' && p === '/api/projects') {
      const out = [];
      for (const n of listVault().notes) {
        if (n.tipe !== 'proyek') continue;
        const c = cache.get(n.path);
        out.push({ path: n.path, id: c.fm.id || slug(n.title), name: n.title, status: n.status || 'aktif', port: c.fm.port || '', lokasi: c.fm.lokasi || '', summary: getSummary(c.raw), tasks: tasksOf(c.raw).filter(t => t.text.trim()) });
      }
      return json(res, 200, { projects: out });
    }
    // --- kompatibel dengan CLI lama ---
    if (M === 'POST' && p === '/api/project') { const r = upsertProject(await readJSON(req)); markDirty(); return json(res, 200, r); }
    if (M === 'POST' && p === '/api/note') {
      const b = await readJSON(req), text = s(b.text, 4000);
      if (!text) throw new HttpErr(400, 'teks wajib diisi');
      const first = text.split('\n')[0].replace(/[#*`\[\]^]/g, '').trim();
      const pr = b.projectId ? findProject(b.projectId) : null;
      const r = createNote({ title: wibDate() + ' ' + (shortTitle(first) || 'catatan'), tipe: TYPES.includes(b.type) ? b.type : 'catatan', oleh: s(b.by, 40) || 'claude', proyekRel: pr || undefined, body: text });
      if (pr) touchProject(pr);
      markDirty(); return json(res, 200, r);
    }
    if (M === 'POST' && p === '/api/task') {
      const b = await readJSON(req), pr = findProject(b.projectId), text = s(b.text, 500);
      if (!pr) throw new HttpErr(400, 'proyek tidak ditemukan');
      if (!text) throw new HttpErr(400, 'teks wajib diisi');
      const id = addTask(pr, text); markDirty(); return json(res, 200, { id, path: pr });
    }
    if (M === 'GET' && p === '/api/discover') {
      const home = os.homedir(), out = [];
      for (const d of fs.readdirSync(home, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
        const full = path.join(home, d.name), marks = [];
        for (const m of ['package.json', 'requirements.txt', 'pyproject.toml', '.git', 'ecosystem.config.cjs', 'ecosystem.config.js']) if (fs.existsSync(path.join(full, m))) marks.push(m);
        if (marks.length) out.push({ name: d.name, path: full, marks });
      }
      return json(res, 200, out);
    }
    return json(res, 404, { error: 'rute tidak ada' });
  } catch (e) {
    if (e instanceof HttpErr) return json(res, e.code, { error: e.message });
    console.error(e); return json(res, 500, { error: e.message });
  }
});

if (migrate()) console.log('vault dibuat dari memory.json');
listVault();
lastStamp = lastBackupStamp = stampOf(listVault().notes);
writeHandoff(); getPm2().then(writeHandoff);
server.listen(PORT, '0.0.0.0', () => console.log('claude-dashboard (vault) di port ' + PORT));
process.on('SIGTERM', () => { try { writeHandoff(); } catch {} process.exit(0); });
