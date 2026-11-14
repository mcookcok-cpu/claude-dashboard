#!/usr/bin/env node
// CLI ingatan Pusat Komando Claude. Pakai: node cm.mjs <perintah> ...
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const key = fs.readFileSync(path.join(dir, 'data/token.txt'), 'utf8').trim();
const base = process.env.CM_URL || 'http://127.0.0.1:2200';

async function call(method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-key': key }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) { console.error('GAGAL', r.status, t); process.exit(1); }
  return t;
}
function parse(args) {
  const pos = [], f = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) f[args[i].slice(2)] = args[++i];
    else pos.push(args[i]);
  }
  return { pos, f };
}
const [, , cmd, ...rest] = process.argv;
const { pos, f } = parse(rest);

const help = `Pemakaian:
  node cm.mjs list                                   daftar proyek, tugas terbuka, dan id-nya
  node cm.mjs handoff                                tampilkan HANDOFF.md
  node cm.mjs note "teks" [--proyek id] [--tipe keputusan|catatan|masalah|selesai|info|sesi] [--oleh nama]
  node cm.mjs task <id-proyek> "teks tugas"
  node cm.mjs done <id-tugas>                        tandai selesai / buka lagi
  node cm.mjs project <id> "Nama" [--status aktif|jeda|selesai|masalah] [--ringkas "..."] [--path /folder] [--port 1234]`;

if (cmd === 'list') {
  const st = JSON.parse(await call('GET', '/api/state'));
  for (const p of st.mem.projects) {
    console.log(`\n# ${p.name} [${p.id}] (${p.status})${p.port ? ' port ' + p.port : ''}`);
    if (p.summary) console.log('  ' + p.summary);
    for (const t of st.mem.tasks.filter(t => t.projectId === p.id)) console.log(`  [${t.done ? 'x' : ' '}] ${t.text}  (${t.id})`);
  }
  if (!st.mem.projects.length) console.log('(belum ada proyek)');
} else if (cmd === 'handoff') {
  console.log(await call('GET', '/handoff.md'));
} else if (cmd === 'note') {
  if (!pos[0]) { console.error(help); process.exit(1); }
  const n = JSON.parse(await call('POST', '/api/note', { text: pos.join(' '), projectId: f.proyek, type: f.tipe, by: f.oleh || 'claude' }));
  console.log('tercatat:', n.id);
} else if (cmd === 'task') {
  if (!pos[0] || !pos[1]) { console.error(help); process.exit(1); }
  const t = JSON.parse(await call('POST', '/api/task', { projectId: pos[0], text: pos.slice(1).join(' ') }));
  console.log('tugas ditambah:', t.id);
} else if (cmd === 'done') {
  if (!pos[0]) { console.error(help); process.exit(1); }
  const t = JSON.parse(await call('POST', '/api/task/' + pos[0] + '/toggle'));
  console.log(t.done ? 'selesai' : 'dibuka lagi', t.id);
} else if (cmd === 'project') {
  if (!pos[0] || !pos[1]) { console.error(help); process.exit(1); }
  const p = JSON.parse(await call('POST', '/api/project', { id: pos[0], name: pos[1], status: f.status, summary: f.ringkas, path: f.path, port: f.port }));
  console.log('proyek tersimpan:', p.id);
} else {
  console.log(help);
}
