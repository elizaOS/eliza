<div align="center">
  <img src="packages/shared-brand/assets/banners/elizaos_banner.svg" alt="elizaOS" width="100%" />
</div>

**elizaOS** is an agentic operating system built on Linux and Android Open Source Project (AOSP).

## Quickstart

```bash
bun install            # workspace install
bun run dev            # API + Vite UI for apps/app
bun run build          # turbo build across the workspace
bun run lint           # turbo lint across the workspace
bun run test           # full test suite (packages/scripts/run-all-tests.mjs)
```

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

- [`app-companion`](plugins/plugin-companion) — chat-first companion with a custom React UI.
- [`app-browser`](plugins/app-browser) — agent-driven browser automation.
- [`app-documents`](plugins/plugin-documents) — RAG over user documents (scoped global / owner-private / user-private / agent-private).
- [`app-phone`](plugins/plugin-phone) — voice + telephony surface.
- [`plugin-form`](plugins/plugin-form) — form-driven data collection.
- [`app-task-coordinator`](plugins/plugin-task-coordinator) — multi-agent orchestration.
- [`app-training`](plugins/plugin-training) — trajectory capture + native prompt optimization.

## Create a new plugin

A _plugin_ extends the runtime with actions, providers, or services — no UI required.

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

| Category             | Examples                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Conversational       | [`chat`](packages/examples/chat), [`discord`](packages/examples/discord), [`telegram`](packages/examples/telegram), [`farcaster`](packages/examples/farcaster), [`farcaster-miniapp`](packages/examples/farcaster-miniapp), [`twitter-xai`](packages/examples/twitter-xai), [`bluesky`](packages/examples/bluesky) |
| Web frameworks       | [`next`](packages/examples/next), [`react`](packages/examples/react), [`html`](packages/examples/html), [`browser-extension`](packages/examples/browser-extension), [`rest-api`](packages/examples/rest-api)                                                                                                       |
| Hosting / serverless | [`vercel`](packages/examples/vercel), [`cloudflare`](packages/examples/cloudflare), [`gcp`](packages/examples/gcp), [`aws`](packages/examples/aws), [`supabase`](packages/examples/supabase), [`convex`](packages/examples/convex)                                                                                 |
| Protocols            | [`mcp`](packages/examples/mcp), [`a2a`](packages/examples/a2a)                                                                                                                                                                                                                                                     |
| On-chain / trading   | [`polymarket`](packages/examples/polymarket), [`trader`](packages/examples/trader), [`lp-manager`](packages/examples/lp-manager)                                                                                                                                                                                   |
| Fun / games          | [`tic-tac-toe`](packages/examples/tic-tac-toe), [`text-adventure`](packages/examples/text-adventure), [`game-of-life`](packages/examples/game-of-life), [`roblox`](packages/examples/roblox), [`elizagotchi`](packages/examples/elizagotchi)                                                                       |
| Other                | [`autonomous`](packages/examples/autonomous), [`avatar`](packages/examples/avatar), [`code`](packages/examples/code), [`form`](packages/examples/form), [`moltbook`](packages/examples/moltbook), [`_plugin`](packages/examples/_plugin)                                                                           |

## Benchmarks

[`packages/benchmarks/`](packages/benchmarks) — 30+ evaluation suites for measuring agent capability. Each lives in its own subdirectory with its own harness and README.

| Category           | Benchmarks                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General agent      | [`gaia`](packages/benchmarks/gaia), [`agentbench`](packages/benchmarks/agentbench), [`tau-bench`](packages/benchmarks/tau-bench), [`gauntlet`](packages/benchmarks/gauntlet), [`realm`](packages/benchmarks/realm), [`trust`](packages/benchmarks/trust), [`experience`](packages/benchmarks/experience)                     |
| Coding             | [`swe_bench`](packages/benchmarks/swe_bench), [`bfcl`](packages/benchmarks/bfcl), [`mint`](packages/benchmarks/mint)                                                                                                                                                                                                         |
| OS / desktop       | [`OSWorld`](packages/benchmarks/OSWorld), [`terminal-bench`](packages/benchmarks/terminal-bench)                                                                                                                                                                                                                             |
| Web                | [`mind2web`](packages/benchmarks/mind2web), [`webshop`](packages/benchmarks/webshop)                                                                                                                                                                                                                                         |
| On-chain / trading | [`HyperliquidBench`](packages/benchmarks/HyperliquidBench), [`solana`](packages/benchmarks/solana), [`evm`](packages/benchmarks/evm), [`vending-bench`](packages/benchmarks/vending-bench)                                                                                                                                   |
| Voice / multimodal | [`voicebench`](packages/benchmarks/voicebench)                                                                                                                                                                                                                                                                               |
| Specialized        | [`adhdbench`](packages/benchmarks/adhdbench), [`clawbench`](packages/benchmarks/clawbench), [`openclaw-benchmark`](packages/benchmarks/openclaw-benchmark), [`woobench`](packages/benchmarks/woobench), [`rlm-bench`](packages/benchmarks/rlm-bench), [`social-alpha`](packages/benchmarks/social-alpha)                     |
| elizaOS-specific   | [`app-eval`](packages/benchmarks/app-eval), [`configbench`](packages/benchmarks/configbench), [`context-bench`](packages/benchmarks/context-bench), [`framework`](packages/benchmarks/framework), [`orchestrator`](packages/benchmarks/orchestrator), [`orchestrator_lifecycle`](packages/benchmarks/orchestrator_lifecycle) |

The runbook for orchestrator-driven benchmark runs is [`packages/benchmarks/ORCHESTRATOR_SUBAGENT_BENCHMARK_RUNBOOK.md`](packages/benchmarks/ORCHESTRATOR_SUBAGENT_BENCHMARK_RUNBOOK.md). The Eliza adapter that lets a benchmark drive an Eliza agent lives at [`packages/benchmarks/eliza-adapter`](packages/benchmarks/eliza-adapter). A combined results viewer is at [`packages/benchmarks/viewer`](packages/benchmarks/viewer).

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
