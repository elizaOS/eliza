# Eliza 🤖

<div align="center">
  <img src="/docs/static/img/eliza_banner.jpg" alt="Eliza Banner" width="100%" />
</div>

<div align="center">

## 🚩 Gambaran keseluruhan

<div align="center">
  <img src="/docs/static/img/eliza_diagram.png" alt="Diagram Eliza" width="100%" />
</div>

📖 [Dokumentasi](https://elizaos.github.io/eliza/) | 🎯 [Contoh](https://github.com/thejoven/awesome-eliza)

</div>

## ✨ Apakah Ciri-cirinya?

- 🛠️ Sambungan lengkap untuk Discord, Twitter, dan Telegram.
- 👥 Sokongan pelbagai ejen dan bilik.
- 📚 Interaksi pintar dengan dokumen serta mudah untuk disemak.
- 💾 Memori hebat yang boleh mengingati perkara lepas! Juga dengan ruang simpanan mencukupi.
- 🚀 Penyebaran pantas yang luar biasa — mari mula bina ejen anda sendiri!
- ☁️ Menyokong pelbagai model seperti:
  - LLaMA (model sumber terbuka AI)
  - Grok (sistem AI lanjutan)
  - OpenAI (model seperti ChatGPT)
  - Anthropic dan banyak lagi!
- 📦 Sedia digunakan pada bila-bila masa dengan mudah!

## Tutorial Video

[Sekolah Pengembang Agen AI](https://www.youtube.com/watch?v=ArptLpQiKfI&list=PLx5pnFXdPTRzWla0RaOxALTSTnVq53fKL)

## 🎯 Bagaimana Ia Boleh Membantu Saya?

- 🤖 Bot sembang
- 🕵️ Ejen berdikari
- 📈 Pengurusan perniagaan
- 🎮 Watak bukan pemain (NPC) dalam permainan video
- 🧠 Dagangan

## 🚀 Mula Sekarang!

## Kontributor

<a href="https://github.com/elizaos/eliza/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=elizaos/eliza" />
</a>

## Riwayat Bintang

[![Grafik Riwayat Bintang](https://api.star-history.com/svg?repos=elizaos/eliza\&type=Date)](https://star-history.com/#elizaos/eliza&Date)

### Apakah Keperluan Asas?

- [Python 2.7+](https://www.python.org/downloads/)
- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [pnpm](https://pnpm.io/installation)

> **Untuk pengguna Windows, anda perlu ada Subsistem Windows untuk Linux:** [WSL 2](https://learn.microsoft.com/de-de/windows/wsl/install-manual).

### Mulakan Eliza Secara Manual (Hanya disyorkan untuk pemalam atau pembangunan platform)

#### Lihat keluaran terkini 

```bash 
# Klon repositori
git clone https://github.com/elizaos/eliza.git

# Projek ini berulang dengan pantas, jadi kami mengesyorkan anda menyemak keluaran terkini
git checkout $(git describe --tags --abbrev=0)

# Jika perkara di atas tidak menyemak keluaran terkini, ini sepatutnya berfungsi:
# git checkout $(git describe --tags `git rev-list --tags --max-count=1`)
 ```

Jika anda mahukan fail aksara contoh juga, jalankan ini: 
```bash 
# Muat turun submodule aksara daripada repo aksara kemas kini submodule git --init
```
#### Edit fail .env Salin .env.example ke .env dan isikan nilai yang sesuai. 

```
cp .env.example .env

```
Nota: .env adalah pilihan. Jika anda merancang untuk menjalankan berbilang ejen yang berbeza, anda boleh menyampaikan rahsia melalui watak JSON


