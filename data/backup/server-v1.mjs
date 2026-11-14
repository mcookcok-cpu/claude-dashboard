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
const BACKUP = path.join(DATA, 'backup');
fs.mkdirSync(BACKUP, { recursive: true });
const F_MEM = path.join(DATA, 'memory.json');
const F_JOURNAL = path.join(DATA, 'journal.jsonl');
const F_HANDOFF = path.join(DATA, 'HANDOFF.md');
const F_TOKEN = path.join(DATA, 'token.txt');
const STATUSES = ['aktif', 'jeda', 'selesai', 'masalah'];
const TYPES = ['keputusan', 'catatan', 'masalah', 'selesai', 'info', 'sesi'];

let TOKEN;
if (fs.existsSync(F_TOKEN)) TOKEN = fs.readFileSync(F_TOKEN, 'utf8').trim();
else { TOKEN = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(F_TOKEN, TOKEN + '\n', { mode: 0o600 }); }

const uid = () => crypto.randomBytes(4).toString('hex');
const s = (v, n) => String(v ?? '').trim().slice(0, n);
const nowISO = () => new Date().toISOString();
const fmt = ts => ts ? new Date(ts).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }) + ' WIB' : '-';

// ---------- INGATAN ----------
let mem = { projects: [], notes: [], tasks: [], updatedAt: null };
function loadLatestBackup() {
  const files = fs.readdirSync(BACKUP).filter(f => f.endsWith('.json')).sort().reverse();
  for (const f of files) {
    try { mem = JSON.parse(fs.readFileSync(path.join(BACKUP, f), 'utf8')); console.log('dipulihkan dari', f); return; } catch {}
  }
}
if (fs.existsSync(F_MEM)) {
  try { mem = JSON.parse(fs.readFileSync(F_MEM, 'utf8')); }
  catch (e) { console.error('memory.json rusak:', e.message); loadLatestBackup(); }
}
for (const k of ['projects', 'notes', 'tasks']) if (!Array.isArray(mem[k])) mem[k] = [];

let lastBackup = 0, hoTimer = null;
function save(action, detail) {
  mem.updatedAt = nowISO();
  const tmp = F_MEM + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(mem, null, 2));
  fs.renameSync(tmp, F_MEM);
  fs.appendFileSync(F_JOURNAL, JSON.stringify({ ts: mem.updatedAt, action, detail }) + '\n');
  if (Date.now() - lastBackup > 600000) {
    lastBackup = Date.now();
    const stamp = mem.updatedAt.replace(/[:.]/g, '-');
    fs.copyFileSync(F_MEM, path.join(BACKUP, 'memory-' + stamp + '.json'));
    const old = fs.readdirSync(BACKUP).filter(f => f.endsWith('.json')).sort();
    while (old.length > 30) fs.unlinkSync(path.join(BACKUP, old.shift()));
  }
  clearTimeout(hoTimer); hoTimer = setTimeout(writeHandoff, 400);
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
  return {
    cpu: cpuPct, cores: os.cpus().length, load: os.loadavg().map(x => Math.round(x * 100) / 100),
    ram: { total, used: total - avail, avail }, swap: { total: swT, used: swT - swF },
    disk: await getDisk(), uptime: os.uptime(), time: Date.now()
  };
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
          pm2Cache = { t: Date.now(), v: arr.map(a => ({
            id: a.pm_id, name: a.name, status: a.pm2_env?.status,
            uptime: a.pm2_env?.pm_uptime ? Date.now() - a.pm2_env.pm_uptime : 0,
            restarts: a.pm2_env?.restart_time, mem: a.monit?.memory, cpu: a.monit?.cpu, pid: a.pid
          })) };
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

// ---------- HANDOFF ----------
function buildHandoff() {
  const L = [];
  const cm = 'node ' + path.join(DIR, 'cm.mjs');
  L.push('# HANDOFF — Pusat Komando Claude');
  L.push('> Dibuat otomatis dari ingatan dashboard. Terakhir diperbarui: ' + fmt(mem.updatedAt));
  L.push('');
  L.push('## Mulai dari sini (untuk agent Claude berikutnya)');
  L.push('1. Baca seluruh file ini sebelum bertindak.');
  L.push('2. Cek server: `pm2 list`');
  L.push('3. Lanjutkan tugas yang masih terbuka di bagian Proyek.');
  L.push('4. Catat progres setiap langkah penting:');
  L.push('   - `' + cm + ' note "teks" --proyek <id> --tipe keputusan|catatan|masalah|selesai|info|sesi`');
  L.push('   - `' + cm + ' task <id-proyek> "tugas baru"`  dan  `' + cm + ' done <id-tugas>`');
  L.push('   - `' + cm + ' list` untuk melihat proyek, tugas terbuka, dan id-nya');
  L.push('5. Sebelum berhenti atau kena limit, tulis satu catatan `--tipe sesi`: apa yang sudah dikerjakan, apa yang belum, dan langkah berikutnya.');
  L.push('6. Jangan hentikan pm2 `mcp-server` dan `mcp-ngrok` (jalur akses agent ke VM ini).');
  L.push('7. Balas dalam bahasa Indonesia, ringkas (pengguna memakai HP).');
  L.push('');
  L.push('## Server');
  const pm = pm2Cache.v || [];
  L.push('- pm2: ' + (pm.length ? pm.map(p => p.name + ' (' + p.status + ')').join(', ') : '(belum terbaca)'));
  L.push('- Dashboard ini: port ' + PORT + ', folder `' + DIR + '`, file ini: `' + F_HANDOFF + '`');
  L.push('- Alamat: ' + (localIPs().map(i => 'http://' + i + ':' + PORT).join(' , ') || '-'));
  L.push('');
  L.push('## Proyek');
  if (!mem.projects.length) L.push('(belum ada proyek tercatat)');
  for (const p of mem.projects) {
    const ts = mem.tasks.filter(t => t.projectId === p.id);
    const open = ts.filter(t => !t.done), done = ts.filter(t => t.done).slice(-5);
    const notes = mem.notes.filter(n => n.projectId === p.id).slice(-5);
    L.push('');
    L.push('### ' + p.name + ' (`' + p.id + '`) — ' + (p.status || 'aktif'));
    if (p.summary) L.push('- Ringkasan: ' + p.summary);
    if (p.path) L.push('- Lokasi: `' + p.path + '`');
    if (p.port) L.push('- Port: ' + p.port);
    L.push('- Diperbarui: ' + fmt(p.updatedAt));
    L.push('- Tugas terbuka:' + (open.length ? '' : ' tidak ada'));
    for (const t of open) L.push('  - [ ] ' + t.text + ' (`' + t.id + '`)');
    if (done.length) { L.push('- Selesai terakhir:'); for (const t of done) L.push('  - [x] ' + t.text); }
    if (notes.length) { L.push('- Catatan terakhir:'); for (const n of notes) L.push('  - [' + n.type + '] ' + fmt(n.ts) + ' — ' + n.text); }
  }
  const general = mem.notes.filter(n => !n.projectId).slice(-15).reverse();
  L.push('');
  L.push('## Catatan umum (tanpa proyek)');
  if (!general.length) L.push('(tidak ada)');
  for (const n of general) L.push('- [' + n.type + '] ' + fmt(n.ts) + ' — ' + n.by + ': ' + n.text);
  L.push('');
  L.push('## Semua catatan terbaru (20)');
  for (const n of mem.notes.slice(-20).reverse()) {
    const pj = mem.projects.find(p => p.id === n.projectId);
    L.push('- [' + n.type + '] ' + fmt(n.ts) + ' — ' + n.by + (pj ? ' (' + pj.name + ')' : '') + ': ' + n.text);
  }
  return L.join('\n') + '\n';
}
function writeHandoff() { try { fs.writeFileSync(F_HANDOFF, buildHandoff()); } catch (e) { console.error('handoff gagal:', e.message); } }

// ---------- HTTP ----------
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
function readJSON(req) {
  return new Promise((resolve, reject) => {
    let b = '', n = 0;
    req.on('data', c => { n += c.length; if (n > 200000) { reject(new Error('terlalu besar')); req.destroy(); return; } b += c; });
    req.on('end', () => { if (!b) return resolve({}); try { resolve(JSON.parse(b)); } catch { reject(new Error('JSON tidak valid')); } });
  });
}
function authed(req, url) {
  const k = req.headers['x-key'] || url.searchParams.get('key');
  if (!k) return false;
  const a = Buffer.from(String(k)), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const slug = n => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(DIR, 'public/index.html')));
    }
    if (p === '/healthz') return json(res, 200, { ok: true });
    if (!(p.startsWith('/api/') || p === '/handoff.md')) return json(res, 404, { error: 'tidak ditemukan' });
    if (!authed(req, url)) return json(res, 401, { error: 'kunci salah' });

    if (req.method === 'GET' && p === '/handoff.md') {
      await getPm2();
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(buildHandoff());
    }
    if (req.method === 'GET' && p === '/api/state') {
      const [sys, pm2] = await Promise.all([getSystem(), getPm2()]);
      return json(res, 200, { meta: { dir: DIR, home: os.homedir(), host: os.hostname(), ips: localIPs(), port: PORT }, mem, sys, pm2 });
    }
    if (req.method === 'GET' && p === '/api/discover') {
      const home = os.homedir(), out = [];
      for (const d of fs.readdirSync(home, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
        const full = path.join(home, d.name), marks = [];
        for (const m of ['package.json', 'requirements.txt', 'pyproject.toml', '.git', 'ecosystem.config.cjs', 'ecosystem.config.js'])
          if (fs.existsSync(path.join(full, m))) marks.push(m);
        if (marks.length) out.push({ name: d.name, path: full, marks });
      }
      return json(res, 200, out);
    }

    if (req.method === 'POST' && p === '/api/project') {
      const b = await readJSON(req);
      const name = s(b.name, 80);
      if (!name) return json(res, 400, { error: 'nama wajib diisi' });
      const id = s(b.id, 60) || slug(name) || uid();
      let pr = mem.projects.find(x => x.id === id);
      const isNew = !pr;
      if (!pr) { pr = { id, createdAt: nowISO() }; mem.projects.push(pr); }
      pr.name = name;
      pr.status = STATUSES.includes(b.status) ? b.status : (pr.status || 'aktif');
      if (b.summary !== undefined) pr.summary = s(b.summary, 1000);
      if (b.path !== undefined) pr.path = s(b.path, 200);
      if (b.port !== undefined) pr.port = s(b.port, 20);
      pr.updatedAt = nowISO();
      save(isNew ? 'project+' : 'project~', { id });
      return json(res, 200, pr);
    }
    if (req.method === 'POST' && p === '/api/note') {
      const b = await readJSON(req);
      const text = s(b.text, 2000);
      if (!text) return json(res, 400, { error: 'teks wajib diisi' });
      const projectId = mem.projects.some(x => x.id === b.projectId) ? b.projectId : null;
      const n = { id: uid(), type: TYPES.includes(b.type) ? b.type : 'catatan', projectId, text, by: s(b.by, 40) || 'claude', ts: nowISO() };
      mem.notes.push(n);
      while (mem.notes.length > 500) mem.notes.shift();
      if (projectId) mem.projects.find(x => x.id === projectId).updatedAt = n.ts;
      save('note+', { id: n.id });
      return json(res, 200, n);
    }
    if (req.method === 'POST' && p === '/api/task') {
      const b = await readJSON(req);
      const text = s(b.text, 500);
      const pr = mem.projects.find(x => x.id === b.projectId);
      if (!pr) return json(res, 400, { error: 'proyek tidak ditemukan' });
      if (!text) return json(res, 400, { error: 'teks wajib diisi' });
      const t = { id: uid(), projectId: pr.id, text, done: false, ts: nowISO() };
      mem.tasks.push(t); pr.updatedAt = t.ts;
      save('task+', { id: t.id });
      return json(res, 200, t);
    }
    const m = p.match(/^\/api\/(project|note|task)\/([\w-]+)(?:\/(toggle))?$/);
    if (m) {
      const [, kind, id, act] = m;
      if (kind === 'task' && act === 'toggle' && req.method === 'POST') {
        const t = mem.tasks.find(x => x.id === id);
        if (!t) return json(res, 404, { error: 'tugas tidak ada' });
        t.done = !t.done; t.doneAt = t.done ? nowISO() : null;
        const pr = mem.projects.find(x => x.id === t.projectId); if (pr) pr.updatedAt = nowISO();
        save('task~', { id });
        return json(res, 200, t);
      }
      if (req.method === 'DELETE') {
        if (kind === 'project') {
          if (!mem.projects.some(x => x.id === id)) return json(res, 404, { error: 'proyek tidak ada' });
          mem.projects = mem.projects.filter(x => x.id !== id);
          mem.tasks = mem.tasks.filter(x => x.projectId !== id);
          for (const n of mem.notes) if (n.projectId === id) n.projectId = null;
        } else if (kind === 'note') mem.notes = mem.notes.filter(x => x.id !== id);
        else mem.tasks = mem.tasks.filter(x => x.id !== id);
        save(kind + '-', { id });
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 404, { error: 'rute tidak ada' });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

writeHandoff();
getPm2().then(writeHandoff);
server.listen(PORT, '0.0.0.0', () => console.log('claude-dashboard di port ' + PORT));
process.on('SIGTERM', () => { try { writeHandoff(); } catch {} process.exit(0); });
