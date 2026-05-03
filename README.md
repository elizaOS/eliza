<div align="center">
  <h1>elizaOS</h1>
  <p><strong>An open-source framework — and a library of applications and benchmarks — for building autonomous AI agents.</strong></p>
</div>

## Framework vs. application

elizaOS is two things stacked together. Knowing which one you're working with makes everything else easier.

**The framework** is the runtime: `@elizaos/core`, the agent loop, the plugin model (actions, providers, services, evaluators), the message/memory/state primitives, and the model-agnostic LLM layer. If you depend on `@elizaos/core` from your own code, you are using the framework.

**An application** is a product *built on* the framework. [`apps/app-companion`](apps/app-companion), [`apps/app-browser`](apps/app-browser), [`apps/app-knowledge`](apps/app-knowledge), [`apps/app-phone`](apps/app-phone), and the rest of [`apps/`](apps) are first-party examples. Each is a self-contained package with its own UI, runtime plugin, data model, and deployment story. They share the framework, not the implementation.

The same split shows up in the directory tree:

```
packages/        ← FRAMEWORK
  core/          # @elizaos/core — runtime, types, agent loop
  agent/         # @elizaos/agent — AgentRuntime + plugin loader
  app-core/      # API + dashboard host
  elizaos/       # the `elizaos` CLI
  prompts/       # shared prompt scaffolding
  ui/            # shared React component library
  examples/      # 30+ standalone examples (chat, discord, mcp, …)
  benchmarks/    # 30+ evaluation suites (gaia, swe_bench, tau-bench, …)

apps/            ← APPLICATIONS
  app-companion/ app-browser/ app-knowledge/ app-phone/
  app-task-coordinator/ app-training/ app-form/ ...

plugins/         ← runtime plugins (connectors + capabilities)
templates/       ← scaffolds used by `APP create` / `PLUGIN create` flows
```

A *plugin* sits between the two: framework-shaped (registers actions/providers/services with the runtime) but shipped and consumed like a product. Community plugins are listed at [elizaOS-plugins/registry](https://github.com/elizaOS-plugins/registry).

## Pick your starting point

| You want to… | Start here |
|---|---|
| Try an agent in 5 minutes | [CLI quick start](#cli-quick-start) |
| Use the runtime from your own TypeScript code (no CLI, no UI) | [Standalone usage](#standalone-usage) |
| Build a new agent application | [Create a new app](#create-a-new-app) |
| Build a runtime plugin (action / provider / service) | [Create a new plugin](#create-a-new-plugin) |
| See how others did it | [Examples](#examples) |
| Evaluate or benchmark an agent | [Benchmarks](#benchmarks) |
| Read the docs | [docs.elizaos.ai](https://docs.elizaos.ai/) |

## CLI quick start

**Prerequisites:** [Node.js v23+](https://nodejs.org/), [bun](https://bun.sh/docs/installation). On Windows, use [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual).

```bash
bun install -g @elizaos/cli
elizaos create my-first-agent       # interactive — pick `fullstack-app` for the standard path
cd my-first-agent
elizaos env edit-local               # add OPENAI_API_KEY=...
elizaos start
```

Web UI: [http://localhost:3000](http://localhost:3000) — API: `http://localhost:3000/api`.

Common follow-ups:

```bash
elizaos dev                          # auto-rebuild on save
elizaos test                         # run tests
elizaos agent list
LOG_LEVEL=debug elizaos start
```

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

## Create a new app

An *application* is a self-contained product on top of the runtime: UI, runtime plugin, metadata. Two paths:

**1. CLI scaffold (recommended).**

```bash
elizaos create my-app -t fullstack-app
cd my-app
bun install
bun run dev
```

`fullstack-app` lays out a full workspace with a local eliza checkout, default plugins (`plugin-sql`, `plugin-elizacloud`, `plugin-local-ai`, `plugin-ollama`), and a Vite + React UI you can edit immediately.

**2. Copy a template directly.** [`templates/min-app/`](templates/min-app) is the smallest possible app — Vite + React UI, a runtime `Plugin` with one action, the `elizaos.app` metadata block in `package.json`, and a vitest smoke test. Read [`templates/min-app/SCAFFOLD.md`](templates/min-app/SCAFFOLD.md) for the placeholders to replace and the verification contract.

For real-world references, browse [`apps/`](apps). A few starting points by complexity:

- [`app-companion`](apps/app-companion) — chat-first companion with a custom React UI.
- [`app-browser`](apps/app-browser) — agent-driven browser automation.
- [`app-knowledge`](apps/app-knowledge) — RAG over user documents.
- [`app-phone`](apps/app-phone) — voice + telephony surface.
- [`app-form`](apps/app-form) — form-driven data collection.
- [`app-task-coordinator`](apps/app-task-coordinator) — multi-agent orchestration.
- [`app-training`](apps/app-training) — trajectory capture + native prompt optimization.

## Create a new plugin

A *plugin* extends the runtime with actions, providers, services, or evaluators — no UI required.

```bash
elizaos create my-plugin -t plugin
cd my-plugin
bun install
bun run build
```

Or copy [`templates/min-plugin/`](templates/min-plugin) directly. See [`templates/min-plugin/SCAFFOLD.md`](templates/min-plugin/SCAFFOLD.md) for the contract.

To publish, run `elizaos publish` once typecheck, lint, and tests pass. Community plugins are listed in [elizaOS-plugins/registry](https://github.com/elizaOS-plugins/registry).

## Examples

[`packages/examples/`](packages/examples) — 30+ runnable references covering connectors, integrations, hosting targets, and gameplay. Each subdirectory is independently buildable and has its own README.

| Category | Examples |
|---|---|
| Conversational | [`chat`](packages/examples/chat), [`discord`](packages/examples/discord), [`telegram`](packages/examples/telegram), [`farcaster`](packages/examples/farcaster), [`farcaster-miniapp`](packages/examples/farcaster-miniapp), [`twitter-xai`](packages/examples/twitter-xai), [`bluesky`](packages/examples/bluesky) |
| Web frameworks | [`next`](packages/examples/next), [`react`](packages/examples/react), [`html`](packages/examples/html), [`browser-extension`](packages/examples/browser-extension), [`rest-api`](packages/examples/rest-api) |
| Hosting / serverless | [`vercel`](packages/examples/vercel), [`cloudflare`](packages/examples/cloudflare), [`gcp`](packages/examples/gcp), [`aws`](packages/examples/aws), [`supabase`](packages/examples/supabase), [`convex`](packages/examples/convex) |
| Protocols | [`mcp`](packages/examples/mcp), [`a2a`](packages/examples/a2a) |
| On-chain / trading | [`polyagent`](packages/examples/polyagent), [`polymarket`](packages/examples/polymarket), [`trader`](packages/examples/trader), [`lp-manager`](packages/examples/lp-manager) |
| Fun / games | [`tic-tac-toe`](packages/examples/tic-tac-toe), [`text-adventure`](packages/examples/text-adventure), [`game-of-life`](packages/examples/game-of-life), [`town`](packages/examples/town), [`roblox`](packages/examples/roblox), [`elizagotchi`](packages/examples/elizagotchi) |
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
bun run dev            # API + Vite UI
bun run build          # tsdown + vite
bun run verify         # typecheck + lint
bun run test           # parallel test suite
bun run test:e2e       # end-to-end
```

Key framework packages:

- **[`@elizaos/core`](packages/core)** — runtime, types, agent loop. The package the framework starts and ends with.
- **[`@elizaos/agent`](packages/agent)** — `AgentRuntime`, plugin loader, default plugin map.
- **[`@elizaos/app-core`](packages/app-core)** — Express API + dashboard host that runs agents.
- **[`elizaos`](packages/elizaos)** — the `elizaos` CLI: `create`, `start`, `dev`, `test`, `env`, `agent`, `publish`, `upgrade`.
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
