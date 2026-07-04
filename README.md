<div align="center">
  <img src="packages/shared/assets/banners/elizaos_banner.svg" alt="elizaOS" width="100%" />
  <h1>elizaOS</h1>
  <p><strong>Your agentic operating system.</strong></p>
  <p>
    <a href="https://eliza.app">Homepage</a> ·
    <a href="https://app.elizacloud.ai">Web app</a> ·
    <a href="https://os.elizacloud.ai">Install the OS</a> ·
    <a href="https://docs.elizaos.ai/">Docs</a> ·
    <a href="https://plugins.elizacloud.ai">App catalog</a>
  </p>
</div>

## What is this?

elizaOS is an open-source, local-first operating system for AI agents. Two parts:

- **Eliza** — the app. An AI assistant for **desktop, mobile, and web**: chat, voice, your messaging accounts, a personal-assistant brain, a non-custodial wallet, browser automation, and on-device models.
- **elizaOS** — the runtime and the OS underneath it. The same runtime can take over the whole machine — boot a **Linux** desktop or run on **Android** as the system assistant.

The agent, your data, and the models all run on your device. [Eliza Cloud](#eliza-cloud-optional) is optional — add it for hosted inference, sync, and deploys.

## Get Eliza

| Platform                              | How                                                                 |
| ------------------------------------- | ------------------------------------------------------------------- |
| **Web**                               | Open [app.elizacloud.ai](https://app.elizacloud.ai)                 |
| **Desktop** — macOS · Windows · Linux | Download from [GitHub Releases](https://github.com/elizaOS/eliza/releases) |
| **iOS · Android**                     | App Store · Play · sideload                                         |

Run from source:

```bash
git clone --filter=blob:none https://github.com/elizaos/eliza.git
cd eliza
bun install
bun run dev          # API + the Eliza app UI
```

To run a whole device as elizaOS instead, see [elizaOS — the operating system](#elizaos-the-operating-system).

## What Eliza does

The app ships with:

- 💬 **Chat** — one inbox for your agent and your accounts (iMessage, Discord, Telegram, WhatsApp, Slack, Farcaster, X).
- 🎙️ **Voice** — hands-free voice with on-device transcription and natural speech.
- 📇 **Phone · Messages · Contacts** — telephony and SMS surfaces (native on Android).
- 🧠 **Personal assistant** — calendar, reminders, inbox triage, tasks, daily brief, and owner-approved actions.
- 🌐 **Browser & computer use** — the agent drives a real browser and desktop.
- 👛 **Wallet** — non-custodial EVM + Solana: transfers, swaps, bridges, LP. Every spend needs your OK.
- 📄 **Documents** — ask questions over your files (RAG).
- 📷 **Camera & vision** — capture and reason over images.
- ⚙️ **Automations** — schedule recurring work; pick models and routing.

## Private by default

Eliza can run the whole pipeline on your device via **Eliza-1**, the on-device model family (Gemma-4):

- **Text** generation and embeddings, from ~2B (phone) to ~27B (desktop).
- **Voice** — local speech-to-text and text-to-speech; audio never leaves the device.
- **Vision & images** — on-device description and generation.

Pick a model in **Settings → Model Routing** and it downloads and pins; from then on it works with no network.

## Apps on elizaOS

elizaOS runs **apps**, not just an agent. An app is a plugin that adds a surface inside Eliza; the runtime installs, launches, and tracks it like real software, and it survives restarts.

- **Browse & install** — catalog at [plugins.elizacloud.ai](https://plugins.elizacloud.ai); curated entries in [`packages/registry`](packages/registry), plus any npm package tagged `elizaos`.
- **First-party apps** — [`plugin-browser`](plugins/plugin-browser), [`plugin-documents`](plugins/plugin-documents), [`plugin-phone`](plugins/plugin-phone), [`plugin-task-coordinator`](plugins/plugin-task-coordinator).
- **Earn** — apps deployed through Eliza Cloud can be metered and monetized.

## elizaOS — the operating system

[`packages/os`](packages/os) is the real, bootable distribution. Downloads and hardware are at **[os.elizacloud.ai](https://os.elizacloud.ai)**.

- **Linux** ([`packages/os/linux`](packages/os/linux)) — boots a full desktop with Eliza built in from a USB stick. amd64 · arm64 · riscv64.
- **Android** ([`packages/os/android`](packages/os/android)) — Eliza is the system launcher and assistant, on Pixel-class devices.

The OS is bootable today; full device certification and production update channels are in progress — see the per-target READMEs for status.

## Eliza Cloud (optional)

Optional managed backend for going beyond one device. Never required — local-only is first-class. It adds:

- **Auth** — accounts and sign-in (OAuth/SIWS).
- **Hosted inference** — model routing across providers, billed per use.
- **Deploy** — push an agent or app to a container with its own domain.
- **Sync & bridge** — state across devices; drive a local agent from the cloud dashboard.
- **Monetization** — metering and creator earnings for published apps, agents, and MCPs.

## Build on elizaOS

The runtime is open source and yours to extend. Start with the CLI:

```bash
bun add -g elizaos@beta
elizaos create my-app --template project   # a deployable app workspace
elizaos create my-plugin -t plugin         # a runtime plugin (action/provider/service)
```

The runtime is **model-agnostic** (OpenAI, Anthropic, Gemini, Grok, Llama, local Eliza-1, …) and extended through a small set of primitives:

- **`@elizaos/core`** ([packages/core](packages/core)) — the agent loop, plugin model, and message/memory/state primitives.
- **`@elizaos/agent`** ([packages/agent](packages/agent)) — `AgentRuntime`, the plugin loader, and the default plugin map.
- **`@elizaos/app-core`** ([packages/app-core](packages/app-core)) — the API + dashboard host that runs agents.
- **`elizaos`** ([packages/elizaos](packages/elizaos)) — the CLI: `create`, `info`, `upgrade`.

A **plugin** exports a `Plugin` that registers **actions** (what the agent does), **providers** (prompt context), **services** (long-lived singletons), and **evaluators** (post-response work). Import `@elizaos/core` directly to use the runtime with no CLI or UI — see [`packages/examples`](packages/examples) and the evaluation suites in [`packages/benchmarks`](packages/benchmarks). Full guides: **[docs.elizaos.ai](https://docs.elizaos.ai/)**.

## Working in the monorepo

```bash
bun install            # workspace install
bun run install:light  # skip the large artifact download when disk or time is tight
bun run dev            # API + Vite UI for apps/app
bun run build          # turbo build across the workspace
bun run test           # full test suite
bun run cloud:mock     # boot the local cloud backend stack with mocks
```

The repo is self-contained — runtime, CLI, dashboard, native OS forks, cloud backend, and first-party plugins all live here. Every package carries its own `README.md`; read it before working inside. Tree map: [`AGENTS.md`](AGENTS.md).

## Contributing

Contributions welcome. Open an issue before sending a non-trivial PR. Before
opening a PR, read [CONTRIBUTING.md](CONTRIBUTING.md) and the evidence standard
in [PR_EVIDENCE.md](PR_EVIDENCE.md); frontend-testable changes need screenshots,
video, logs, and any relevant real-LLM trajectories attached under
[`.github/issue-evidence/`](.github/issue-evidence/).

- [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md)
- [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)
- [Windows Setup](WINDOWS.md)

All community spaces are covered by our [Code of Conduct](CODE_OF_CONDUCT.md).
To report a security vulnerability, follow [SECURITY.md](SECURITY.md); do not
open a public issue.

## License

MIT — see [LICENSE](LICENSE).
