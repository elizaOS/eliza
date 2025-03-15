# Eliza 🤖

<div align="center">
  <img src="./docs/static/img/eliza_banner.jpg" alt="Eliza Banner" width="100%" />
</div>

<div align="center">

📖 [Documentatie](https://elizaos.github.io/eliza/) | 🎯 [Voorbeelden](https://github.com/thejoven/awesome-eliza)

</div>

## 🌍 README Vertalingen

[中文说明](./README_CN.md) | [日本語の説明](./README_JA.md) | [한국어 설명](./README_KOR.md) | [Français](./README_FR.md) | [Português](./README_PTBR.md) | [Türkçe](./README_TR.md) | [Русский](./README_RU.md) | [Español](./README_ES.md) | [Italiano](./README_IT.md) | [ไทย](./README_TH.md) | [Deutsch](./README_DE.md) | [Tiếng Việt](./README_VI.md) | [עִברִית](https://github.com/elizaos/Elisa/blob/main/README_HE.md) | [Tagalog](./README_TG.md) | [Polski](./README_PL.md) | [Arabic](./README_AR.md) | [Hungarian](./README_HU.md) | [Srpski](./README_RS.md)

## 🚩 Overzicht

<div align="center">
  <img src="./docs/static/img/eliza_diagram.jpg" alt="Eliza Diagram" width="100%" />
</div>

## ✨ Functies

- 🛠️ Volledige Discord, Twitter en Telegram integraties
- 🔗 Ondersteuning voor alle modellen (Llama, Grok, OpenAI, Anthropic, etc.)
- 👥 Ondersteuning voor meerdere agenten en ruimtes
- 📚 Eenvoudig documenten importeren en ermee werken
- 💾 Opvraagbaar geheugen en documentopslag
- 🚀 Zeer uitbreidbaar - maak je eigen acties en clients
- ☁️ Ondersteunt vele modellen (lokale Llama, OpenAI, Anthropic, Groq, etc.)
- 📦 Werkt direct!

## Video Tutorials

[AI Agent Ontwikkelschool](https://www.youtube.com/watch?v=ArptLpQiKfI&list=PLx5pnFXdPTRzWla0RaOxALTSTnVq53fKL)

## 🎯 Toepassingen

- 🤖 Chatbots
- 🕵️ Autonome Agents
- 📈 Bedrijfsprocessen
- 🎮 Video Game NPC's
- 🧠 Trading

## 💰 Als je van plan bent een token te lanceren

Dit framework is het nummer één open source project op GitHub. We maken de volgende generatie mens-machine interface mogelijk, maar we hebben nog steeds je hulp nodig om ervoor te zorgen dat de code van de hoogste kwaliteit is met snelle reactie op kritieke problemen die onze ontwikkelaarsgemeenschap beïnvloeden.

Om duurzame ontwikkeling en continue innovatie te garanderen, vragen we bijdragen van 5-10% van initiële token distributies van succesvolle lanceringen.

Alle bijdragen worden publiekelijk bijgehouden op de blockchain en worden uitsluitend gebruikt voor ecosysteemontwikkeling.

### ⚠️ Vergeet de grote baas geen fooi van 10% te geven.: ⚠️
[AM84n1iLdxgVTAyENBcLdjXoyvjentTbu5Q6EpKV1PeG](https://solscan.io/account/AM84n1iLdxgVTAyENBcLdjXoyvjentTbu5Q6EpKV1PeG)

## 🚀 Quick Start

### Vereisten

- [Python 2.7+](https://www.python.org/downloads/)
- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [bun](https://bun.io/installation)

> **Opmerking voor Windows-gebruikers:** [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual) is vereist.

### Gebruik de Starter (Aanbevolen)

```bash
git clone https://github.com/elizaos/eliza-starter.git
cd eliza-starter
cp .env.example .env
bun i && bun run build && bun start
```

Zodra de agent draait, zou je het bericht moeten zien om "bun start:client" uit te voeren.
Open een nieuwe terminal in dezelfde map en voer onderstaand commando uit. Volg daarna de URL om met je agent te chatten.

```bash
bun start:client
```

Lees vervolgens de [Documentatie](https://elizaos.github.io/eliza/) om te leren hoe je je Eliza kunt aanpassen.

### Eliza Handmatig Starten (Alleen aanbevolen als je weet wat je doet)

```bash
# Clone de repository
git clone https://github.com/elizaos/eliza.git

# Check de laatste release uit
# Dit project ontwikkelt snel, dus we raden aan om de laatste release te gebruiken
git checkout $(git describe --tags --abbrev=0)
```

### Bewerk het .env bestand

Kopieer .env.example naar .env en vul de juiste gegevens in.

```
cp .env.example .env
```

Opmerking: .env is optioneel. Als je van plan bent om meerdere agenten te draaien, kun je geheimen doorgeven via het character JSON bestand

### Eliza Automatisch Starten

Dit zal alles uitvoeren om het project op te zetten en de bot te starten met het standaard karakter.

```bash
sh scripts/start.sh
```

### Bewerk het character bestand

1. Open `packages/core/src/defaultCharacter.ts` om het standaard karakter aan te passen. Verwijder // om de code actief te maken en bewerk het karakter.

2. Om aangepaste karakters te laden:
    - Gebruik `bun start --characters="pad/naar/jouw/karakter.json"`
    - Meerdere karakterbestanden kunnen tegelijk worden geladen
3. Verbinden met X (Twitter)
    - verander `"clients": []` naar `"clients": ["twitter"]` in het karakterbestand om te verbinden met X

### Eliza Handmatig Starten

```bash
bun i
bun run build
bun start
```

#### Aanvullende Vereisten

Mogelijk moet je Sharp installeren. Als je een fout ziet bij het opstarten, probeer het dan te installeren met het volgende commando:

```
bun install --include=optional sharp
```

### Community & contact

- [GitHub Issues](https://github.com/elizaos/eliza/issues). Het beste voor: bugs die je tegenkomt bij het gebruik van Eliza, en functievoorstellen.
- [Discord](https://discord.gg/ai16z). Het beste voor: het delen van je toepassingen en praten met de community.
- [Ontwikkelaars Discord](https://discord.gg/3f67SH4rXT). Het beste voor: hulp krijgen en plugin ontwikkeling.

## Bijdragers

<a href="https://github.com/elizaos/eliza/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=elizaos/eliza" />
</a>

## Ster Historie

[![Star History Chart](https://api.star-history.com/svg?repos=elizaos/eliza&type=Date)](https://star-history.com/#elizaos/eliza&Date)