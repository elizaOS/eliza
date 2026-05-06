<div align="center">
  <h1>elizaOS</h1>
  <p><strong>An open-source framework for building autonomous AI agents.</strong></p>
</div>

## ✨ What is Eliza?

elizaOS is an all-in-one, extensible platform for building and deploying AI-powered applications. Whether you're creating sophisticated chatbots, autonomous agents for business process automation, or intelligent game NPCs, Eliza provides the tools you need to get started quickly and scale effectively.

It combines a modular architecture, a powerful CLI, and a rich web interface to give you full control over your agents' development, deployment, and management lifecycle.

For complete guides and API references, visit our official **[documentation](https://docs.elizaos.ai/)**.

## 🚀 Key Features

- 🔌 **Rich Connectivity**: Out-of-the-box connectors for Discord, Telegram, Farcaster, and more.
- 🧠 **Model Agnostic**: Supports all major models, including OpenAI, Gemini, Anthropic, Llama, and Grok.
- 🖥️ **Modern Web UI**: A professional dashboard for managing agents, groups, and conversations in real-time.
- 🤖 **Multi-Agent Architecture**: Designed from the ground up for creating and orchestrating groups of specialized agents.
- 📄 **Document Ingestion**: Easily ingest documents and allow agents to retrieve information and answer questions from your data (RAG).
- 🛠️ **Highly Extensible**: Build your own functionality with a powerful plugin system.
- 📦 **It Just Works**: A seamless setup and development experience from day one.

> **Looking for plugins?** Browse the community plugin registry at **[elizaOS-plugins/registry](https://github.com/elizaOS-plugins/registry)** for a full list of available ElizaOS plugins.

## Framework, Projects, And App Plugins

elizaOS is a framework plus packages built on top of it. Knowing which layer
you're working with keeps projects, plugins, and app surfaces from getting
mixed together.

**The framework** is the runtime: `@elizaos/core`, the agent loop, the plugin model (actions, providers, services, evaluators), the message/memory/state primitives, and the model-agnostic LLM layer. If you depend on `@elizaos/core` from your own code, you are using the framework.

**A project** is a deployable product workspace built on the framework. A
generated project owns its branded app shell, usually under `apps/app` inside
that project workspace.

**An app plugin** is a runtime plugin that also contributes an app surface inside
Eliza. First-party app plugins live under [`plugins/app-*`](plugins), keep npm
names like `@elizaos/app-companion`, and are loaded by package name. They are
plugins, not top-level repo applications.

The same split shows up in the directory tree:

```
packages/        ← framework and shared packages
  core/          # @elizaos/core — runtime, types, agent loop
  agent/         # @elizaos/agent — AgentRuntime + plugin loader
  app-core/      # API + dashboard host
  elizaos/       # the `elizaos` CLI
  prompts/       # shared prompt scaffolding
  ui/            # shared React component library
  examples/      # standalone examples (chat, discord, mcp, ...)
  benchmarks/    # evaluation suites (gaia, swe_bench, tau-bench, ...)

plugins/         ← runtime plugins and app plugins
  app-companion/ app-browser/ app-knowledge/ app-phone/
  app-task-coordinator/ app-training/ plugin-form/ ...
  plugin-discord/ plugin-openai/ plugin-sql/ ...

packages/elizaos/templates/   ← CLI scaffolds + min-project / min-plugin for APP/PLUGIN create
```

A *plugin* sits between the two: framework-shaped (registers actions/providers/services with the runtime) but shipped and consumed like a product. Community plugins are listed at [elizaOS-plugins/registry](https://github.com/elizaOS-plugins/registry).

## Pick your starting point

| You want to… | Start here |
|---|---|
| Try an agent in 5 minutes | [CLI quick start](#cli-quick-start) |
| Use the runtime from your own TypeScript code (no CLI, no UI) | [Standalone usage](#standalone-usage) |
| Build a new deployable product | [Create a new project](#create-a-new-project) |
| Build a runtime plugin (action / provider / service) | [Create a new plugin](#create-a-new-plugin) |
| See how others did it | [Examples](#examples) |
| Evaluate or benchmark an agent | [Benchmarks](#benchmarks) |
| Read the docs | [docs.elizaos.ai](https://docs.elizaos.ai/) |

## CLI quick start

**Prerequisites:** [Node.js v24+](https://nodejs.org/), [bun](https://bun.sh/docs/installation). On Windows, use [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual).

```bash
bun add -g elizaos
elizaos create my-first-agent --template project
cd my-first-agent
# add OPENAI_API_KEY=... to .env (or your provider's key)
bun install
bun run dev
```

The generated project exposes the runtime scripts you'll use day-to-day: `bun run dev`, `bun run build`, `bun run test`, `bun run typecheck`, `bun run lint`, `bun run verify`. The `elizaos` CLI itself is intentionally minimal — its job is scaffolding (`elizaos create`) and template upgrades (`elizaos upgrade`). For a list of available templates, run `elizaos info`.

Full reference: `elizaos --help` or `elizaos <command> --help`.

## Standalone usage

Use `@elizaos/core` directly — no CLI, no dashboard, just the runtime in your code.

```bash
git clone --filter=blob:none https://github.com/elizaos/eliza.git
cd eliza
bun install

# Interactive REPL against a real agent
OPENAI_API_KEY=your_key bun run packages/examples/chat/chat.ts
```

Nearly every surface has a working example in [`packages/examples/`](packages/examples) — 30+ in total. Each one has its own README and runs independently. They are the fastest way to see the framework standing on its own. See [Examples](#examples) below for the highlights.

> **About the partial clone.** `--filter=blob:none` gives you the full history but fetches file contents on demand — about 10× smaller. `git log`, branches, and `git checkout` work normally; `git blame` and `git log -p` will fetch on first use. To upgrade later: `git config --unset remote.origin.partialclonefilter && git fetch --refetch`. For one-off CI, `--depth=1 --single-branch` is even smaller.

## Create a new project

A project is a self-contained product workspace on top of the runtime: branded
app shell, local eliza checkout, app plugin selection, platform config, and
deployment scripts. Two paths:

**1. CLI scaffold (recommended).**

```bash
elizaos create my-app --template project
cd my-app
bun install
bun run dev
```

The project template lays out a full workspace with a local eliza checkout, default plugins (`plugin-sql`, `plugin-elizacloud`, `plugin-local-ai`, `plugin-ollama`), and a Vite + React UI you can edit immediately.

**2. Copy a template directly.** [`packages/elizaos/templates/min-project/`](packages/elizaos/templates/min-project) is the smallest possible app — Vite + React UI, a runtime `Plugin` with one action, the `elizaos.app` metadata block in `package.json`, and a vitest smoke test. Read [`packages/elizaos/templates/min-project/SCAFFOLD.md`](packages/elizaos/templates/min-project/SCAFFOLD.md) for the placeholders to replace and the verification contract.

For first-party app plugin references, browse [`plugins/app-*`](plugins). A few starting points by complexity:

- [`app-companion`](plugins/app-companion) — chat-first companion with a custom React UI.
- [`app-browser`](plugins/app-browser) — agent-driven browser automation.
- [`app-knowledge`](plugins/app-knowledge) — RAG over user documents.
- [`app-phone`](plugins/app-phone) — voice + telephony surface.
- [`plugin-form`](plugins/plugin-form) — form-driven data collection.
- [`app-task-coordinator`](plugins/app-task-coordinator) — multi-agent orchestration.
- [`app-training`](plugins/app-training) — trajectory capture + native prompt optimization.

## Create a new plugin

A *plugin* extends the runtime with actions, providers, services, or evaluators — no UI required.

```bash
elizaos create my-plugin -t plugin
cd my-plugin
bun install
bun run build
```

Or copy [`packages/elizaos/templates/min-plugin/`](packages/elizaos/templates/min-plugin) directly. See [`packages/elizaos/templates/min-plugin/SCAFFOLD.md`](packages/elizaos/templates/min-plugin/SCAFFOLD.md) for the contract.

Once typecheck, lint, and tests pass, publish to npm. Community plugins are listed in [elizaOS-plugins/registry](https://github.com/elizaOS-plugins/registry).

## Examples

[`packages/examples/`](packages/examples) — 30+ runnable references covering connectors, integrations, hosting targets, and gameplay. Each subdirectory is independently buildable and has its own README.

| Category | Examples |
|---|---|
| Conversational | [`chat`](packages/examples/chat), [`discord`](packages/examples/discord), [`telegram`](packages/examples/telegram), [`farcaster`](packages/examples/farcaster), [`farcaster-miniapp`](packages/examples/farcaster-miniapp), [`twitter-xai`](packages/examples/twitter-xai), [`bluesky`](packages/examples/bluesky) |
| Web frameworks | [`next`](packages/examples/next), [`react`](packages/examples/react), [`html`](packages/examples/html), [`browser-extension`](packages/examples/browser-extension), [`rest-api`](packages/examples/rest-api) |
| Hosting / serverless | [`vercel`](packages/examples/vercel), [`cloudflare`](packages/examples/cloudflare), [`gcp`](packages/examples/gcp), [`aws`](packages/examples/aws), [`supabase`](packages/examples/supabase), [`convex`](packages/examples/convex) |
| Protocols | [`mcp`](packages/examples/mcp), [`a2a`](packages/examples/a2a) |
| On-chain / trading | [`polymarket`](packages/examples/polymarket), [`trader`](packages/examples/trader), [`lp-manager`](packages/examples/lp-manager) |
| Fun / games | [`tic-tac-toe`](packages/examples/tic-tac-toe), [`text-adventure`](packages/examples/text-adventure), [`game-of-life`](packages/examples/game-of-life), [`roblox`](packages/examples/roblox), [`elizagotchi`](packages/examples/elizagotchi) |
| Other | [`autonomous`](packages/examples/autonomous), [`avatar`](packages/examples/avatar), [`code`](packages/examples/code), [`form`](packages/examples/form), [`moltbook`](packages/examples/moltbook), [`_plugin`](packages/examples/_plugin) |

## Benchmarks

[`packages/benchmarks/`](packages/benchmarks) — 30+ evaluation suites for measuring agent capability. Each lives in its own subdirectory with its own harness and README.

| Category | Benchmarks |
|---|---|
| General agent | [`gaia`](packages/benchmarks/gaia), [`agentbench`](packages/benchmarks/agentbench), [`tau-bench`](packages/benchmarks/tau-bench), [`gauntlet`](packages/benchmarks/gauntlet), [`realm`](packages/benchmarks/realm), [`trust`](packages/benchmarks/trust), [`experience`](packages/benchmarks/experience) |
| Coding | [`swe_bench`](packages/benchmarks/swe_bench), [`bfcl`](packages/benchmarks/bfcl), [`mint`](packages/benchmarks/mint) |
| OS / desktop | [`OSWorld`](packages/benchmarks/OSWorld), [`terminal-bench`](packages/benchmarks/terminal-bench) |
| Web | [`mind2web`](packages/benchmarks/mind2web), [`webshop`](packages/benchmarks/webshop) |
| On-chain / trading | [`HyperliquidBench`](packages/benchmarks/HyperliquidBench), [`solana`](packages/benchmarks/solana), [`evm`](packages/benchmarks/evm), [`vending-bench`](packages/benchmarks/vending-bench) |
| Voice / multimodal | [`voicebench`](packages/benchmarks/voicebench) |
| Specialized | [`adhdbench`](packages/benchmarks/adhdbench), [`clawbench`](packages/benchmarks/clawbench), [`openclaw-benchmark`](packages/benchmarks/openclaw-benchmark), [`woobench`](packages/benchmarks/woobench), [`rlm-bench`](packages/benchmarks/rlm-bench), [`social-alpha`](packages/benchmarks/social-alpha) |
| elizaOS-specific | [`app-eval`](packages/benchmarks/app-eval), [`configbench`](packages/benchmarks/configbench), [`context-bench`](packages/benchmarks/context-bench), [`framework`](packages/benchmarks/framework), [`orchestrator`](packages/benchmarks/orchestrator), [`orchestrator_lifecycle`](packages/benchmarks/orchestrator_lifecycle) |

The runbook for orchestrator-driven benchmark runs is [`packages/benchmarks/ORCHESTRATOR_SUBAGENT_BENCHMARK_RUNBOOK.md`](packages/benchmarks/ORCHESTRATOR_SUBAGENT_BENCHMARK_RUNBOOK.md). The Eliza adapter that lets a benchmark drive an Eliza agent lives at [`packages/benchmarks/eliza-adapter`](packages/benchmarks/eliza-adapter). A combined results viewer is at [`packages/benchmarks/viewer`](packages/benchmarks/viewer).

## Working in the monorepo

```bash
bun install            # workspace install
bun run dev            # API + Vite UI for apps/app
bun run build          # turbo build across the workspace
bun run lint           # turbo lint across the workspace
bun run test           # full test suite (scripts/run-all-tests.mjs)
```

Key framework packages:

- **[`@elizaos/core`](packages/core)** — runtime, types, agent loop. The package the framework starts and ends with.
- **[`@elizaos/agent`](packages/agent)** — `AgentRuntime`, plugin loader, default plugin map.
- **[`@elizaos/app-core`](packages/app-core)** — Express API + dashboard host that runs agents.
- **[`elizaos`](packages/elizaos)** — the `elizaos` CLI: `create`, `info`, `upgrade`, `version`.
- **[`@elizaos/prompts`](packages/prompts)** — shared prompt scaffolding.
- **[`@elizaos/ui`](packages/ui)** — shared React component library.
- **[`plugins/`](plugins)** — connectors and capabilities (Telegram, Discord, Farcaster, Twitter/X, browser, video, TEE, …).

## Contributing

Contributions welcome. Open an issue before sending a non-trivial PR.

- [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md)
- [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md)

## License

MIT — see [LICENSE](LICENSE).

## Contributors

<a href="https://github.com/elizaos/eliza/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=elizaos/eliza" alt="Eliza project contributors" />
</a>
