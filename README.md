# Eliza 🤖

<div align="center">
  <img src="./docs/static/img/eliza_banner.jpg" alt="Eliza Banner" width="100%" />
</div>

<div align="center">

📑 [Technical Report](https://arxiv.org/pdf/2501.06781) | 📖 [Documentation](https://elizaos.github.io/eliza/) | 🎯 [Examples](https://github.com/thejoven/awesome-eliza)

</div>

## 🌍 README Translations

[中文说明](packages/docs/i18n/readme/README_CN.md) | [日本語の説明](packages/docs/i18n/readme/README_JA.md) | [한국어 설명](packages/docs/i18n/readme/README_KOR.md) | [Persian](packages/docs/i18n/readme/README_FA.md) | [Français](packages/docs/i18n/readme/README_FR.md) | [Português](packages/docs/i18n/readme/README_PTBR.md) | [Türkçe](packages/docs/i18n/readme/README_TR.md) | [Русский](packages/docs/i18n/readme/README_RU.md) | [Español](packages/docs/i18n/readme/README_ES.md) | [Italiano](packages/docs/i18n/readme/README_IT.md) | [ไทย](packages/docs/i18n/readme/README_TH.md) | [Deutsch](packages/docs/i18n/readme/README_DE.md) | [Tiếng Việt](packages/docs/i18n/readme/README_VI.md) | [עִברִית](packages/docs/i18n/readme/README_HE.md) | [Tagalog](packages/docs/i18n/readme/README_TG.md) | [Polski](packages/docs/i18n/readme/README_PL.md) | [Arabic](packages/docs/i18n/readme/README_AR.md) | [Hungarian](packages/docs/i18n/readme/README_HU.md) | [Srpski](packages/docs/i18n/readme/README_RS.md) | [Română](packages/docs/i18n/readme/README_RO.md) | [Nederlands](packages/docs/i18n/readme/README_NL.md) | [Ελληνικά](packages/docs/i18n/readme/README_GR.md)

## 🚩 Overview

<div align="center">
  <img src="./docs/static/img/eliza_diagram.jpg" alt="Eliza Diagram" width="100%" />
</div>

## ✨ Features

- 🛠️ Full-featured Discord, X (Twitter) and Telegram connectors
- 🔗 Support for every model (Llama, Grok, OpenAI, Anthropic, Gemini, etc.)
- 👥 Multi-agent and room support
- 📚 Easily ingest and interact with your documents
- 💾 Retrievable memory and document store
- 🚀 Highly extensible - create your own actions and clients
- 📦 Just works!

## Video Tutorials

[AI Agent Dev School](https://www.youtube.com/watch?v=ArptLpQiKfI&list=PLx5pnFXdPTRzWla0RaOxALTSTnVq53fKL)

## 🎯 Use Cases

- 🤖 Chatbots
- 🕵️ Autonomous Agents
- 📈 Business Process Handling
- 🎮 Video Game NPCs
- 🧠 Trading

## 🚀 Quick Start

### Prerequisites

- [Python 2.7+](https://www.python.org/downloads/)
- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [bun](https://bun.sh/docs/installation)

> **Note for Windows Users:** [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual) is required.

### Use the Starter (Recommended)

```bash
git clone https://github.com/elizaos/eliza-starter.git
cd eliza-starter
cp .env.example .env
bun i && bun run build && bun start
```

### Manually Start Eliza (Only recommended if you know what you are doing)

#### Checkout the latest release

```bash
# Clone the repository
git clone https://github.com/elizaos/eliza.git

# This project iterates fast, so we recommend checking out the latest release
git checkout $(git describe --tags --abbrev=0)
# If the above doesn't checkout the latest release, this should work:
# git checkout $(git describe --tags `git rev-list --tags --max-count=1`)
```

#### Edit the .env file

Copy .env.example to .env and fill in the appropriate values.

```
cp .env.example .env
```

Note: .env is optional. If you're planning to run multiple distinct agents, you can pass secrets through the character JSON

#### Start Eliza

Important! We now use Bun. If you are using npm, you will need to install Bun:
https://bun.sh/docs/installation

```bash
bun install
bun run build # npm will work too
bun start # npm will work too
```

### Interact via Browser

Once the agent is running, you can visit http://localhost:3000 to interact with your agent through a web interface. The interface provides:

- Real-time chat with your agent
- Character configuration options
- Plugin management
- Memory and conversation history

---

### Automatically Start Eliza

The start script provides an automated way to set up and run Eliza:

## Citation

We now have a [paper](https://arxiv.org/pdf/2501.06781) you can cite for the Eliza OS:

```bibtex
@article{walters2025eliza,
  title={Eliza: A Web3 friendly AI Agent Operating System},
  author={Walters, Shaw and Gao, Sam and Nerd, Shakker and Da, Feng and Williams, Warren and Meng, Ting-Chien and Han, Hunter and He, Frank and Zhang, Allen and Wu, Ming and others},
  journal={arXiv preprint arXiv:2501.06781},
  year={2025}
}
```

## Contributors

<a href="https://github.com/elizaos/eliza/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=elizaos/eliza" alt="Eliza project contributors" />
</a>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=elizaos/eliza&type=Date)](https://star-history.com/#elizaos/eliza&Date)

## Git Hooks

This project uses git hooks to ensure code quality:

- **pre-commit**: Automatically formats staged files using Prettier before committing

To run the pre-commit hook manually:

```bash
bun run pre-commit
```

# env settings

These are the variables that I have set

```
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=5
ELEVENLABS_OUTPUT_FORMAT=pcm_16000
ELEVENLABS_VOICE_SIMILARITY_BOOST=0.9
ELEVENLABS_VOICE_STABILITY=0.5
ELEVENLABS_VOICE_STYLE=0.66
ELEVENLABS_VOICE_USE_SPEAKER_BOOST=false
EMBEDDING_GROQ_MODEL=llama-3.1-8b-instant
ENABLE_ACTION_PROCESSING=false
ENABLE_TWITTER_POST_GENERATION=true
HOME=/home/agent
LARGE_GROQ_MODEL=llama-3.2-90b-vision-preview
LOG_JSON_FORMAT=false
MAX_ACTIONS_PROCESSING=1
MEDIUM_GROQ_MODEL=llama-3.3-70b-versatile
NODE_ENV=development
POST_IMMEDIATELY=false
POST_INTERVAL_MAX=180
POST_INTERVAL_MIN=90
SERVER_PORT=3000
SMALL_GROQ_MODEL=llama-3.1-8b-instant
TOKENIZER_IMAGE=h4ckermike/arm64-tokenizers:feature-arm64
TRANSCRIPTION_PROVIDER=deepgram
TWITTER_APPROVAL_CHECK_INTERVAL=60000
TWITTER_APPROVAL_ENABLED=true
TWITTER_DRY_RUN=false
TWITTER_POLL_INTERVAL=120
TWITTER_RETRY_LIMIT=10
TWITTER_SEARCH_ENABLE=false
TWITTER_SPACES_ENABLE=true
USE_CHARACTER_STORAGE=false
VERBOSE=TRUE
DEVREL_IMPORT_KNOWLEDGE=true
LOG_LEVEL=debug
## SECRET
DEEPGRAM_API_KEY=XXX
DISCORD_API_TOKEN=XXXX
DISCORD_APPLICATION_ID=11611
DISCORD_VOICE_CHANNEL_ID=11111
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
ELEVENLABS_XI_API_KEY=DDDD
GROQ_API_KEY=dddd
TELEGRAM_ACCOUNT_APP_HASH=dddd
TELEGRAM_ACCOUNT_APP_ID=1233
TELEGRAM_ACCOUNT_PHONE=+222222
TELEGRAM_BOT_TOKEN=dd:dd

TWITTER_APPROVAL_DISCORD_BOT_TOKEN=ffsdf
TWITTER_APPROVAL_DISCORD_CHANNEL_ID=111111

TWITTER_EMAIL=tine@s0lfunmeme.com
TWITTER_PASSWORD=NOPE
TWITTER_TARGET_USERS=intros3p3ctor
TWITTER_USERNAME=TineI3sNotEliza

```

you only need this with my scripts
`AGENT_IMAGE=h4ckermike/elizaos-eliza:feature-v2-cloud-deploy-v2`
