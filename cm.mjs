#!/usr/bin/env node
// CLI ingatan Pusat Komando Claude (vault ala Obsidian). Pakai: node cm.mjs <perintah> ...
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
  node cm.mjs list                                   proyek, tugas terbuka, dan id-nya
  node cm.mjs handoff                                tampilkan HANDOFF.md
  node cm.mjs note "teks" [--proyek id] [--tipe keputusan|catatan|masalah|selesai|info|sesi] [--oleh nama]
  node cm.mjs task <id-proyek> "teks tugas"
  node cm.mjs done <id-tugas>                        centang / buka lagi (id seperti t-abc123 atau 584a4e33)
  node cm.mjs project <id> "Nama" [--status aktif|jeda|selesai|masalah] [--ringkas "..."] [--path /folder] [--port 1234]
  node cm.mjs daily ["teks"]                         tambah baris ke catatan harian hari ini (tanpa teks: tampilkan)
  node cm.mjs append "Folder/Judul.md" "teks"        tambah teks ke akhir catatan
  node cm.mjs search kata [tag:x tipe:y]             cari catatan
  node cm.mjs read "Folder/Judul.md"                 baca isi catatan
  node cm.mjs new "Judul" [--folder Catatan] [--isi "teks"] [--tags a,b]`;

const J = t => JSON.parse(t);
if (cmd === 'list') {
  const { projects } = J(await call('GET', '/api/projects'));
  for (const p of projects) {
    console.log(`\n# ${p.name} [${p.id}] (${p.status})${p.port ? ' port ' + p.port : ''}`);
    if (p.summary) console.log('  ' + p.summary);
    for (const t of p.tasks) console.log(`  [${t.done ? 'x' : ' '}] ${t.text}  (${t.id || p.path + ':' + t.line})`);
  }
  if (!projects.length) console.log('(belum ada proyek)');
} else if (cmd === 'handoff') {
  console.log(await call('GET', '/handoff.md'));
} else if (cmd === 'note') {
  if (!pos[0]) { console.error(help); process.exit(1); }
  const n = J(await call('POST', '/api/note', { text: pos.join(' '), projectId: f.proyek, type: f.tipe, by: f.oleh || 'claude' }));
  console.log('tercatat:', n.path);
} else if (cmd === 'task') {
  if (!pos[0] || !pos[1]) { console.error(help); process.exit(1); }
  const t = J(await call('POST', '/api/task', { projectId: pos[0], text: pos.slice(1).join(' ') }));
  console.log('tugas ditambah:', t.id);
} else if (cmd === 'done') {
  if (!pos[0]) { console.error(help); process.exit(1); }
  let ref = pos[0];
  if (/^[0-9a-f]{8}$/.test(ref)) ref = 't-' + ref;
  const t = J(await call('POST', '/api/task/toggle', { ref }));
  console.log(t.done ? 'selesai' : 'dibuka lagi', '-', t.text);
} else if (cmd === 'project') {
  if (!pos[0] || !pos[1]) { console.error(help); process.exit(1); }
  const p = J(await call('POST', '/api/project', { id: pos[0], name: pos[1], status: f.status, summary: f.ringkas, path: f.path, port: f.port }));
  console.log('proyek tersimpan:', p.path);
} else if (cmd === 'daily') {
  if (!pos[0]) { const r = J(await call('POST', '/api/daily', {})); console.log(J(await call('GET', '/api/note?path=' + encodeURIComponent(r.path))).raw); }
  else { const r = J(await call('POST', '/api/append', { path: 'daily', text: '- ' + pos.join(' ') })); console.log('ditambah ke', r.path); }
} else if (cmd === 'append') {
  if (!pos[0] || !pos[1]) { console.error(help); process.exit(1); }
  const r = J(await call('POST', '/api/append', { path: pos[0], text: pos.slice(1).join(' ') }));
  console.log('ditambah ke', r.path);
} else if (cmd === 'search') {
  const r = J(await call('GET', '/api/search?q=' + encodeURIComponent(pos.join(' '))));
  for (const x of r.results) console.log(`- ${x.path}${x.tipe ? ' [' + x.tipe + ']' : ''}\n    ${x.snippet}`);
  if (!r.results.length) console.log('(tidak ada hasil)');
} else if (cmd === 'read') {
  if (!pos[0]) { console.error(help); process.exit(1); }
  console.log(J(await call('GET', '/api/note?path=' + encodeURIComponent(pos[0]))).raw);
} else if (cmd === 'new') {
  if (!pos[0]) { console.error(help); process.exit(1); }
  const r = J(await call('POST', '/api/new', { title: pos[0], folder: f.folder, body: f.isi, tags: f.tags ? f.tags.split(',') : undefined, tipe: f.tipe, oleh: 'claude' }));
  console.log('dibuat:', r.path);
} else {
  console.log(help);
}
