# Eliza - Multi-Agent-Simulationsframework

# https://github.com/elizaos/eliza

# Besuchen Sie https://eliza.builders für Support

# dev branch

<img src="./docs/static/img/eliza_banner.jpg" alt="Eliza Banner" width="100%" />

_Wie gesehen bei [@DegenSpartanAI](https://x.com/degenspartanai) und [@MarcAIndreessen](https://x.com/pmairca)_

- Multi-Agent-Simulationsframework
- Fügen Sie beliebig viele einzigartige Charaktere mit [characterfile](https://github.com/lalalune/characterfile/) hinzu
- Vollständige Discord- und Twitter-Anbindungen, mit Unterstützung für Discord-Sprachkanäle
- Vollständiges Konversations- und Dokument-RAG-Gedächtnis
- Kann Links und PDFs lesen, Audio und Videos transkribieren, Gespräche zusammenfassen und mehr
- Hochgradig erweiterbar - erstellen Sie eigene Aktionen und Clients zur Erweiterung von Elizas Fähigkeiten
- Unterstützt Open-Source- und lokale Modelle (standardmäßig konfiguriert mit Nous Hermes Llama 3.1B)
- Unterstützt OpenAI für Cloud-Inferenz auf ressourcenschonenden Geräten
- "Ask Claude"-Modus für komplexere Anfragen an Claude
- 100% Typescript

# Erste Schritte

**Voraussetzungen (ERFORDERLICH):**

- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [pnpm](https://pnpm.io/installation)

### .env-Datei bearbeiten

- Kopieren Sie .env.example zu .env und füllen Sie die entsprechenden Werte aus
- Bearbeiten Sie die TWITTER-Umgebungsvariablen, um Benutzernamen und Passwort Ihres Bots hinzuzufügen

### Charakterdatei bearbeiten

- Überprüfen Sie die Datei `packages/core/src/defaultCharacter.ts` - Sie können diese modifizieren
- Sie können auch Charaktere mit dem Befehl `pnpm start --characters="path/to/your/character.json"` laden und mehrere Bots gleichzeitig ausführen

Nach dem Einrichten der .env-Datei und der Charakterdatei können Sie den Bot mit folgendem Befehl starten:

```
pnpm i
pnpm start
```

# Eliza anpassen

### Benutzerdefinierte Aktionen hinzufügen

Um Git-Konflikte im Core-Verzeichnis zu vermeiden, empfehlen wir, benutzerdefinierte Aktionen zu einem `custom_actions` -Verzeichnis hinzuzufügen und sie dann in der `elizaConfig.yaml`-Datei zu konfigurieren. Siehe `elizaConfig.example.yaml` als Beispiel.

## Mit verschiedenen Modellen ausführen

### Mit Llama ausführen

Sie können Llama 70B oder 405B Modelle verwenden, indem Sie die `XAI_MODEL`-Umgebungsvariable auf `meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo` oder `meta-llama/Meta-Llama-3.1-405B-Instruct` setzen.

### Mit Grok ausführen

Sie können Grok-Modelle verwenden, indem Sie die `XAI_MODEL` Umgebungsvariable auf `grok-beta` setzen

### Mit OpenAI ausführen

Sie können OpenAI-Modelle verwenden, indem Sie die `XAI_MODEL` Umgebungsvariable auf `gpt-4o-mini` oder `gpt-4o` setzen

## Zusätzliche Anforderungen

Möglicherweise müssen Sie Sharp installieren. Wenn Sie beim Start einen Fehler sehen, versuchen Sie es mit folgendem Befehl zu installieren:

```
pnpm install --include=optional sharp
```

# Umgebungseinrichtung

Sie müssen Umgebungsvariablen in Ihrer .env-Datei hinzufügen, um sich mit verschiedenen Plattformen zu verbinden:

```
# Erforderliche Umgebungsvariablen
DISCORD_APPLICATION_ID=
DISCORD_API_TOKEN= # Bot-Token
OPENAI_API_KEY=sk-* # OpenAI API-Schlüssel, beginnt mit sk-
ELEVENLABS_XI_API_KEY= # API-Schlüssel von Elevenlabs

# ELEVENLABS EINSTELLUNGEN
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
ELEVENLABS_VOICE_STABILITY=0.5
ELEVENLABS_VOICE_SIMILARITY_BOOST=0.9
ELEVENLABS_VOICE_STYLE=0.66
ELEVENLABS_VOICE_USE_SPEAKER_BOOST=false
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=4
ELEVENLABS_OUTPUT_FORMAT=pcm_16000

TWITTER_DRY_RUN=false
TWITTER_USERNAME= # Kontoname
TWITTER_PASSWORD= # Kontopasswort
TWITTER_EMAIL= # Konto-E-Mail
TWITTER_COOKIES= # Konto-Cookies

X_SERVER_URL=
XAI_API_KEY=
XAI_MODEL=

# Für Anfragen an Claude
ANTHROPIC_API_KEY=

WALLET_SECRET_KEY=EXAMPLE_WALLET_SECRET_KEY
WALLET_PUBLIC_KEY=EXAMPLE_WALLET_PUBLIC_KEY

BIRDEYE_API_KEY=

SOL_ADDRESS=So11111111111111111111111111111111111111112
SLIPPAGE=1
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
HELIUS_API_KEY=

## Telegram
TELEGRAM_BOT_TOKEN=

TOGETHER_API_KEY=
```

# Lokale Inferenz-Einrichtung

### CUDA-Einrichtung

Wenn Sie eine NVIDIA-GPU haben, können Sie CUDA installieren, um die lokale Inferenz drastisch zu beschleunigen.

```
pnpm install
npx --no node-llama-cpp source download --gpu cuda
```

Stellen Sie sicher, dass Sie das CUDA Toolkit einschließlich cuDNN und cuBLAS installiert haben.

### Lokal ausführen

Fügen Sie XAI_MODEL und setzen Sie es auf eine der oben genannten Optionen aus [Mit Llama ausführen](#run-with-llama) - Sie können X_SERVER_URL und XAI_API_KEY leer lassen, es lädt das Modell von Huggingface herunter und fragt es lokal ab.

# Clients

## Discord Bot

Hilfe beim Einrichten Ihres Discord-Bots finden Sie hier: https://discordjs.guide/preparations/setting-up-a-bot-application.html

# Entwicklung

## Tests

Um die Testsuite auszuführen:

```bash
pnpm test           # Tests einmal ausführen
pnpm test:watch    # Tests im Watch-Modus ausführen
```

Für datenbankspezifische Tests:

```bash
pnpm test:sqlite   # Tests mit SQLite ausführen
pnpm test:sqljs    # Tests mit SQL.js ausführen
```

Tests werden mit Jest geschrieben und befinden sich in `src/**/*.test.ts`-Dateien. Die Testumgebung ist konfiguriert für:

- Laden von Umgebungsvariablen aus `.env.test`
- 2-Minuten-Timeout für länger laufende Tests
- Unterstützung von ESM-Modulen
- Sequentielle Testausführung (--runInBand)

Um neue Tests zu erstellen, fügen Sie eine `.test.ts`-Datei neben dem zu testenden Code hinzu.
