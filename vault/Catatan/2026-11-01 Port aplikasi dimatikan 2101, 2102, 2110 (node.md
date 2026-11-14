---
tipe: keputusan
proyek: "[[Kondisi & keamanan VM]]"
oleh: claude
dibuat: 2026-10-31T22:41:38.318Z
---
Port aplikasi dimatikan: 2101, 2102, 2110 (node server.mjs), 8899 (python http.server), 9119 (hermes serve). hermes-gateway (layanan user) masih jalan tanpa port. Port sistem dibiarkan: 22 SSH, 53 DNS, 631 CUPS, Tailscale, 49983 (envd bawaan platform).
