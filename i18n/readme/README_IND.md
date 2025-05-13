[![id](https://img.shields.io/badge/lang-Indonesian-red.svg)](README_IND.md)
# Eliza 🤖

<div align="center">
  <img src="/docs/static/img/eliza_banner.jpg" alt="Banner Eliza" width="100%" />
</div>

<div align="center">

📖 [Dokumentasi](https://elizaos.github.io/eliza/) | 🎯 [Contoh](https://github.com/thejoven/awesome-eliza)

</div>

## 🚩 Ikhtisar

<div align="center">
  <img src="/docs/static/img/eliza_diagram.png" alt="Diagram Eliza" width="100%" />
</div>

## ✨ Fitur

* 🛠️ Dukungan penuh untuk integrasi Discord, Twitter, dan Telegram
* 🔗 Kompatibel dengan semua model (Llama, Grok, OpenAI, Anthropic, dll.)
* 👥 Mendukung banyak agen dan ruang
* 📚 Mudah mengelola dan berinteraksi dengan dokumen Anda
* 💾 Memori dan penyimpanan dokumen yang dapat diambil kembali
* 🚀 Sangat fleksibel — Anda dapat membuat aksi dan klien Anda sendiri
* ☁️ Dukungan untuk berbagai model (seperti Llama lokal, OpenAI, Anthropic, dll.)
* 📦 Siap pakai tanpa konfigurasi rumit!

## Tutorial Video

[AI Agent Dev School](https://www.youtube.com/watch?v=ArptLpQiKfI&list=PLx5pnFXdPTRzWla0RaOxALTSTnVq53fKL)

## 🎯 Penggunaan

* 🤖 Chatbot
* 🕵️ Agen otomatis
* 📈 Pengelolaan proses bisnis
* 🎮 Karakter dalam game video
* 🧠 Perdagangan & transaksi

## 🚀 Mulai Cepat

### Prasyarat

* [Python 2.7+](https://www.python.org/downloads/)
* [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
* [pnpm](https://pnpm.io/installation)

> **Catatan untuk Pengguna Windows:** Wajib menggunakan [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual)

### Menggunakan Proyek Awal (Disarankan)

```bash
git clone https://github.com/elizaos/eliza-starter.git
cd eliza-starter
cp .env.example .env
pnpm i && pnpm build && pnpm start
```

Setelah agen berjalan, Anda akan mendapat pesan untuk menjalankan perintah `pnpm start:client`.

Buka terminal baru, pindah ke direktori yang sama, lalu jalankan:

```bash
pnpm start:client
```

Lalu baca [dokumentasi](https://elizaos.github.io/eliza/) untuk mempelajari cara menyesuaikan Eliza.

### Menjalankan Eliza Secara Manual (Disarankan hanya untuk pengguna berpengalaman)

```bash
# Klon repositori
git clone https://github.com/elizaos/eliza.git

# Checkout ke versi stabil terbaru
git checkout $(git describe --tags --abbrev=0)
# Jika gagal, gunakan perintah alternatif ini:
# git checkout $(git describe --tags `git rev-list --tags --max-count=1`)
```

### Menjalankan Eliza di Gitpod

[![Buka di Gitpod](https://gitpod.io/button/open-in-gitpod.svg)](https://gitpod.io/#https://github.com/elizaos/eliza/tree/main)

### Mengedit File .env

Salin dari `.env.example` dan isi nilai-nilai yang sesuai:

```
cp .env.example .env
```

Catatan: `.env` bersifat opsional. Jika Anda ingin menjalankan beberapa agen, rahasia bisa disimpan dalam file karakter JSON.

### Menjalankan Eliza Secara Otomatis

Script berikut akan menyelesaikan semua proses setup dan menjalankan agen dengan karakter default:

```bash
sh scripts/start.sh
```

### Mengedit File Karakter

1. Buka `packages/core/src/defaultCharacter.ts` untuk mengubah karakter default.
2. Untuk memuat karakter kustom:

   * Jalankan `pnpm start --characters="path/to/your/character.json"`
   * Bisa memuat beberapa file karakter sekaligus
3. Integrasi Twitter:

   * Ubah `"clients": []` menjadi `"clients": ["twitter"]` dalam file karakter

### Menjalankan Eliza Secara Manual

```bash
pnpm i
pnpm build
pnpm start

# Jika perlu membersihkan proyek karena perubahan
pnpm clean
```

#### Persyaratan Tambahan

Anda mungkin perlu menginstal Sharp. Jika terjadi error saat startup, jalankan:

```
pnpm install --include=optional sharp
```

### Komunitas & Kontak

* [GitHub Issues](https://github.com/elizaos/eliza/issues) — untuk laporan bug dan permintaan fitur
* [Discord](https://discord.gg/ai16z) — untuk diskusi komunitas dan berbagi ide

## Kontributor

<a href="https://github.com/elizaos/eliza/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=elizaos/eliza" />
</a>

## Riwayat Bintang

[![Grafik Riwayat Bintang](https://api.star-history.com/svg?repos=elizaos/eliza\&type=Date)](https://star-history.com/#elizaos/eliza&Date)
