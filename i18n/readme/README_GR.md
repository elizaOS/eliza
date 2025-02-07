# Eliza 🤖

<div align="center">
  <img src="./docs/static/img/eliza_banner.jpg" alt="Eliza Banner" width="100%" />
</div>

<div align="center">

📖 [Τεκμηρίωση](https://elizaos.github.io/eliza/) | 🎯 [Παραδείγματα](https://github.com/thejoven/awesome-eliza)

</div>

## 🌍 Μεταφράσεις README
[中文说明](./README_CN.md) | [日本語の説明](./README_JA.md) | [한국어 설명](./README_KOR.md) | [Persian](./README_FA.md) | [Français](./README_FR.md) | [Português](./README_PTBR.md) | [Türkçe](./README_TR.md) | [Русский](./README_RU.md) | [Español](./README_ES.md) | [Italiano](./README_IT.md) | [ไทย](./README_TH.md) | [Deutsch](./README_DE.md) | [Tiếng Việt](./README_VI.md) | [עִברִית](https://github.com/elizaos/Elisa/blob/main/README_HE.md) | [Tagalog](./README_TG.md) | [Polski](./README_PL.md) | [Arabic](./README_AR.md) | [Hungarian](./README_HU.md) | [Srpski](./README_RS.md) | [Română](./README_RO.md) | [Nederlands](./README_NL.md) | [Ελληνικά](./README_GR.md)

## 🚩 Επισκόπηση
<div align="center">
  <img src="./docs/static/img/eliza_diagram.png" alt="Eliza Diagram" width="100%" />
</div>

## ✨ Χαρακτηριστικά

- 🛠️ Πλήρεις συνδέσεις για Discord, Twitter και Telegram
- 🔗 Υποστήριξη για κάθε μοντέλο (Llama, Grok, OpenAI, Anthropic, κ.λπ.)
- 👥 Υποστήριξη πολλών πρακτόρων και δωματίων
- 📚 Εύκολη ενσωμάτωση και αλληλεπίδραση με τα έγγραφά σας
- 💾 Ανακτήσιμη μνήμη και αποθήκευση εγγράφων
- 🚀 Εξαιρετικά επεκτάσιμο - δημιουργήστε τις δικές σας δράσεις και πελάτες
- ☁️ Υποστήριξη για πολλά μοντέλα (τοπικά Llama, OpenAI, Anthropic, Groq, κ.λπ.)
- 📦 Έτοιμο για χρήση!

[Σχολείο για προγραμματιστές για Πράκτορες Τεχνητής Νοημοσύνης (ΑΙ)](https://www.youtube.com/watch?v=ArptLpQiKfI&list=PLx5pnFXdPTRzWla0RaOxALTSTnVq53fKL)

## 🎯 Περιτπώσεις για χρήση

- 🤖 Chatbots
- 🕵️ Αυτόνομοι πράκτορες
- 📈 Διαχείριση επιχειρηματικών διαδικασιών
- 🎮 NPC σε βιντεοπαιχνίδια
- 🧠 Trading
- 🚀 Γρήγορη Εκκίνηση


## 🚀 Γρήγορη Εκκίνηση

## Προαπαιτούμενα

- [Python 2.7+](https://www.python.org/downloads/)
- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [bun](https://bun.io/installation)

> **Σημείωση για χρήστες Windows:** Απαιτείται [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual).

### Πως να ξεκινήσετε (Συνιστάται)

```bash
git clone https://github.com/elizaos/eliza-starter.git
cd eliza-starter
cp .env.example .env
bun i && bun run build && bun start
```

Μόλις ο πράκτορας ξεκινήσει, θα δείτε ένα μήνυμα να εκτελέσετε ```bun start:client```.
Ανοίξτε ένα νέο τερματικό, μεταβείτε στον ίδιο κατάλογο και εκτελέστε την παρακάτω εντολή:

```bash
bun start:client
```

Έπειτα διαβάστε την [Τεκμηρίωση]((https://elizaos.github.io/eliza/)) για να μάθετε πώς να προσαρμόσετε το Eliza.

### Χειροκίνητη Εκκίνηση του Eliza (Μόνο για προχωρημένους χρήστες)

```bash
# Κλωνοποίηση του αποθετηρίου
git clone https://github.com/elizaos/eliza.git

# Έλεγχος της τελευταίας έκδοσης
# Αυτό το έργο εξελίσσεται γρήγορα, οπότε συνιστούμε να ελέγξετε την τελευταία έκδοση
git checkout $(git describe --tags --abbrev=0)
# Αν το παραπάνω δεν ελέγξει την τελευταία έκδοση, αυτό θα πρέπει να λειτουργήσει:
# git checkout $(git describe --tags `git rev-list --tags --max-count=1`)
```

### Εκκίνηση του Eliza με το Gitpod

[![Open in Gitpod](https://gitpod.io/button/open-in-gitpod.svg)](https://gitpod.io/#https://github.com/elizaos/eliza/tree/main)
### Τροποποιήστε το .env αρχείο

Αντιγράψτε το αρχείο .env.example σε ένα νέο αρχείο .env και συμπληρώστε τις παραμέτρους που χρειάζεστε.

```
cp .env.example .env
```

Σημείωση: Το .env είναι προαιρετικό. Αν σχεδιάζετε να τρέξετε πολλούς διαφορετικούς πράκτορες, μπορείτε να περάσετε τα secrets μέσω του JSON της χαρακτήρα.  

### Αυτόματη Εκκίνηση του Eliza

Αυτό θα εκτελέσει όλα τα απαραίτητα βήματα για να ρυθμίσετε το έργο και να ξεκινήσετε το bot με τον προεπιλεγμένο χαρακτήρα.

```bash
sh scripts/start.sh
```

### Τροποποίηση του αρχείου σχετικού με τον χαρακτήρα

1. Ανοίξτε το `packages/core/src/defaultCharacter.ts` για να τροποποιήσετε τον προεπιλεγμένο χαρακτήρα. Αποσχολιάστε και επεξεργαστείτε.  

2. Για να φορτώσετε προσαρμοσμένους χαρακτήρες:  
   - Χρησιμοποιήστε `bun start --characters="path/to/your/character.json"`
   - Πολλά αρχεία χαρακτήρων μπορούν να φορτωθούν ταυτόχρονα

3. Σύνδεση με το X (Twitter)
      αλλάξτε `"clients": []` σε `"clients": ["twitter"]` στο αρχείο χαρακτήρα για να συνδεθείτε με το X

### Χειροκίνητη Εκκίνηση του Eliza

```bash
bun i
bun run build
bun start

# Το έργο εξελίσσεται γρήγορα, μερικές φορές πρέπει να καθαρίσετε το έργο, εαν επιστρέφετε στο έργο
```

#### Επιπλέον Πληροφορίες

Μπορεί να χρειαστεί να εγκαταστήσετε το Sharp. Αν αντιμετωπίζετε προβλήματα, προσπαθήστε να το εγκαταστήσετε, εκτελώντας την παρακάτω εντολή:

```
bun install --include=optional sharp
```

### Κοινότητα & Επικοινωνία

- [Προβλήματα στο GitHub](https://github.com/elizaos/eliza/issues). Καλύτερο για: Προβλήματα που αντιμετωπίζετε με το Eliza, και για προτάσεις βελτίωσης.
- [Discord](https://discord.gg/ai16z). Καλύτερο για: Κοινοποίηση των εφαρμογών σας και συνομιλία με την κοινότητα.

## Συνεισφορές

<a href="https://github.com/elizaos/eliza/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=elizaos/eliza" />
</a>

## Ιστορικό Αστεριών

[![Star History Chart](https://api.star-history.com/svg?repos=elizaos/eliza&type=Date)](https://star-history.com/#elizaos/eliza&Date)
