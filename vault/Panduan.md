---
tipe: catatan
oleh: claude
dibuat: 2026-11-01T14:29:13.219Z
tags: [panduan]
---
# Panduan Vault

Ini vault catatan ala Obsidian. Setiap catatan adalah file Markdown biasa di folder `vault/`, jadi agent Claude juga bisa membaca dan menulisnya langsung.

## Dasar
- Tautan antar catatan: tulis `[[Nama Catatan]]` atau `[[Nama Catatan|teks lain]]`. Tautan yang belum ada tampil redup, ketuk untuk membuatnya.
- Tag: tulis `#tag` di mana saja, atau `tags: [a, b]` di properti.
- Tugas: `- [ ] tugas`, ketuk kotaknya untuk mencentang.
- Tautan balik: di bawah tiap catatan ada daftar catatan lain yang menautkannya.
- Catatan harian: tab Harian membuat catatan tanggal hari ini.
- Graf: tab Graf menampilkan peta semua catatan. Ketuk titik untuk melihat tetangganya, ketuk lagi untuk membukanya.

## Pencarian
- Kata biasa: cari di judul dan isi.
- `tag:proyek`, `tipe:sesi`, `path:Harian`, `status:aktif`: saring.
- Tanda kutip untuk frasa: `"pm2 save"`.

## Proyek
- [[Claude Dashboard]]
- [[Akses MCP ke VM]]
- [[Kondisi & keamanan VM]]

## Untuk agent
Baca [HANDOFF.md](HANDOFF.md) dulu. Catat lewat `cm.mjs` (note, task, done, daily, append, search, read).
