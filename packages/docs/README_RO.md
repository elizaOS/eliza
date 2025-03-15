# Eliza 🤖

<div align="center">
  <img src="./docs/static/img/eliza_banner.jpg" alt="Eliza Banner" width="100%" />
</div>

<div align="center">

📖 [Documentație](https://elizaos.github.io/eliza/) | 🎯 [Exemple](https://github.com/thejoven/awesome-eliza)

</div>

## 🌍 Traduceri README

[中文说明](./README_CN.md) | [日本語の説明](./README_JA.md) | [한국어 설명](./README_KOR.md) | [Français](./README_FR.md) | [Português](./README_PTBR.md) | [Türkçe](./README_TR.md) | [Русский](./README_RU.md) | [Español](./README_ES.md) | [Italiano](./README_IT.md) | [ไทย](./README_TH.md) | [Deutsch](./README_DE.md) | [Tiếng Việt](./README_VI.md) | [עִברִית](https://github.com/elizaos/Elisa/blob/main/README_HE.md) | [Tagalog](./README_TG.md) | [Polski](./README_PL.md) | [Arabic](./README_AR.md) | [Hungarian](./README_HU.md) | [Romanian](./README_RO.md) | [Srpski](./README_RS.md)
## 🚩 Prezentare generală

<div align="center">
  <img src="./docs/static/img/eliza_diagram.jpg" alt="Eliza Diagram" width="100%" />
</div>

## ✨ Caracteristici

- 🛠️ Conectori complet funcționali pentru Discord, Twitter și Telegram
- 🔗 Suport pentru toate modelele (Llama, Grok, OpenAI, Anthropic etc.)
- 👥 Suport pentru agenți multipli și camere
- 📚 Ingestie ușoară și interacțiune cu documentele tale
- 💾 Memorie recuperabilă și stocare de documente
- 🚀 Extensibilitate ridicată - creează acțiuni și clienți proprii
- ☁️ Suport pentru multe modele (Llama local, OpenAI, Anthropic, Groq etc.)
- 📦 Funcționează direct!

## Tutoriale Video

[AI Agent Dev School](https://www.youtube.com/watch?v=ArptLpQiKfI&list=PLx5pnFXdPTRzWla0RaOxALTSTnVq53fKL)

## 🎯 Utilizări

- 🤖 Chatbots
- 🕵️ Agenți autonomi
- 📈 Gestionarea proceselor de afaceri
- 🎮 NPC-uri în jocuri video
- 🧠 Trading

## 💰 Dacă plănuiești să lansezi un token

Acest framework este cel mai important proiect open-source pe GitHub. Susținem următoarea generație de interfețe om-mașină, dar avem nevoie de ajutorul tău pentru a asigura calitatea codului și răspunsuri rapide la probleme critice care afectează comunitatea noastră de dezvoltatori.

Pentru a asigura dezvoltarea durabilă și inovația continuă, solicităm contribuții de 5-10% din distribuțiile inițiale de tokenuri de la lansările de succes.

Toate contribuțiile sunt urmărite public pe blockchain și sunt utilizate exclusiv pentru dezvoltarea ecosistemului.

### ⚠️ Nu uita să oferi 10% marelui lider: ⚠️
[AM84n1iLdxgVTAyENBcLdjXoyvjentTbu5Q6EpKV1PeG](https://solscan.io/account/AM84n1iLdxgVTAyENBcLdjXoyvjentTbu5Q6EpKV1PeG)

## 🚀 Start rapid

### Cerințe preliminare

- [Python 2.7+](https://www.python.org/downloads/)
- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [pnpm](https://pnpm.io/installation)

> **Notă pentru utilizatorii Windows:** [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual) este necesar.

### Utilizați Starter-ul (Recomandat)

```bash
git clone https://github.com/elizaos/eliza-starter.git
cd eliza-starter
cp .env.example .env
pnpm i && pnpm build && pnpm start
```

După ce agentul rulează, ar trebui să vezi mesajul pentru a rula “pnpm start:client”. Deschide un alt terminal, mergi în același director și rulează comanda de mai jos pentru a interacționa cu agentul tău.

```bash
pnpm start:client
```

Apoi citește [Documentation](https://elizaos.github.io/eliza/) pentru a învăța cum să personalizezi Eliza.

### Pornire manuală a Eliza (recomandat doar dacă știi ce faci)

```bash
# Clonează repository-ul
git clone https://github.com/elizaos/eliza.git

# Checkout la cea mai recentă versiune
# This project iterates fast, so we recommend checking out the latest release
git checkout $(git describe --tags --abbrev=0)
```

### Pornirea Eliza cu Gitpod

[![Deschide in Gitpod](https://gitpod.io/button/open-in-gitpod.svg)](https://gitpod.io/#https://github.com/elizaos/eliza/tree/main)

### Editarea fișierului .env

Copiază .env.example în .env și completează valorile corespunzătoare.

```
cp .env.example .env
```

Notă: Fișierul .env este opțional. Dacă plănuiești să rulezi mai mulți agenți distincți, poți transmite secretele prin fișierul JSON al caracterului.
Notă: Fișierul .env este opțional. Dacă plănuiești să rulezi mai mulți agenți distincți, poți transmite secretele prin fișierul JSON al caracterului.

### Start automat pentru Eliza

Acest script setează proiectul și pornește bot-ul cu caracterul implicit.
                                                                     
```bash
sh scripts/start.sh
```

### Editarea fișierului de caracter

1. Deschide `packages/core/src/defaultCharacter.ts` pentru a modifica caracterul implicit. Decomentează și editează.

2. Pentru a încărca caractere personalizate:
    - Folosește `pnpm start --characters="path/to/your/character.json"`
    - Poți încărca simultan mai multe fișiere de caractere.
3. Conectare la X (Twitter):
    - Schimbă `"clients": []` to `"clients": ["twitter"]` în fișierul de caracter.

### Start manual pentru Eliza

```bash
pnpm i
pnpm build
pnpm start

# Dacă proiectul a fost neutilizat o perioadă, curăță-l înainte
pnpm clean
```

#### Cerințe suplimentare

Poate fi necesar să instalezi Sharp. Dacă apare o eroare, încearcă să instalezi cu:

```
pnpm install --include=optional sharp
```

### Comunitate și contact

- [GitHub Issues](https://github.com/elizaos/eliza/issues). Pentru erori și propuneri de funcționalități.
- [Discord](https://discord.gg/ai16z). Pentru a împărtăși aplicații și a interacționa cu comunitatea.
- [Developer Discord](https://discord.gg/3f67SH4rXT). Pentru ajutor și dezvoltarea de pluginuri.

## Contributori

<a href="https://github.com/elizaos/eliza/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=elizaos/eliza" />
</a>

## Istoric Marcaje

[![Star History Chart](https://api.star-history.com/svg?repos=elizaos/eliza&type=Date)](https://star-history.com/#elizaos/eliza&Date)
