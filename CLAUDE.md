# elizaOS — repository guide for agents

This is the **elizaOS** monorepo: an open-source framework for building and
deploying autonomous AI agents, plus the runtime, CLI, dashboard, cloud
backend, native bridges, and first-party plugins built on top of it. The repo
is **self-contained** — everything needed to run, test, and ship an Eliza agent
lives here.

`CLAUDE.md` and `AGENTS.md` in every directory are **identical** — author
`CLAUDE.md`, then copy it to `AGENTS.md`. Read the package-local `CLAUDE.md`
before working inside any package or plugin; this root file is the map.

## Naming

Write **elizaOS** (not `ElizaOS`). npm scope is `@elizaos/*`. In plain language,
say **Eliza agents**. Exception: the **Eliza Classic** plugin keeps `Eliza`
(the 1966 chatbot it reimplements).

## Toolchain

- **Runtime:** [Bun](https://bun.sh) (`packageManager` is pinned in
  `package.json`) on **Node 24** (`engines.node`). ESM only (`"type": "module"`).
- **Monorepo:** [Turbo](https://turbo.build) drives `build` / `typecheck` /
  `lint` / `test` across workspaces. Workspace globs are in `package.json`
  (`packages/*`, `plugins/*`, `packages/native/*`, `packages/os/*`,
  `packages/examples/*`, `packages/cloud-services/*`, …).
- **Lint/format:** [Biome](https://biomejs.dev) (`biome.json`). Ignore globs in
  `.biomeignore`.
- **Tests:** Vitest, orchestrated by `packages/scripts/run-all-tests.mjs`.
- **TypeScript:** project-references build; root `tsconfig.json`,
  `tsconfig.base.json`, per-package `tsconfig.json`.

## Root commands

```bash
bun install            # workspace install (runs postinstall: submodules, patches)
bun run dev            # boot the API + dashboard UI (packages/app-core dev-ui)
bun run build          # turbo build across the workspace
bun run verify         # typecheck + lint (alias: bun run check) — run before "done"
bun run lint           # biome lint via turbo
bun run format         # biome format via turbo
bun run typecheck      # tsc across workspace (8 GB heap)
bun run test           # full suite (run-all-tests.mjs)
bun run test:server    # core/agent/app-core/shared/vault/elizaos/skills/scenario-runner
bun run test:client    # app/ui + lifeops/companion/training plugins
bun run test:e2e       # end-to-end lane
bun run start          # run an agent (packages/agent start)
bun run clean          # nuke dist/.turbo/node_modules, reinstall, rebuild
bun run cloud:mock     # boot the full local cloud stack with mocks
```

Scope any command to one package with `--cwd`:
`bun run --cwd packages/core test`. The repo has ~200 root scripts; the list
above is the day-to-day set. Use `bun run` with no args to print them all.

## Repo map — where to find what

```
packages/        framework, shared libraries, and product surfaces
  core/          @elizaos/core — runtime, types, agent loop, memory/state, model layer
  agent/         @elizaos/agent — AgentRuntime, plugin loader, default plugin map
  app-core/      API + dashboard host; dev/build orchestration (dev-ui.mjs)
  elizaos/       the `elizaos` CLI — create / info / upgrade / version; project + plugin templates
  prompts/       shared prompt scaffolding
  shared/        cross-package utilities + brand assets
  ui/            shared React component library
  app/           web + desktop dashboard (Vite + React; desktop shell)
  tui/           terminal UI
  skills/        runtime skills knowledge base (USE_SKILL)
  scenario-runner/ scenario + eval harness
  sweagent/      SWE-bench style coding-agent harness
  cloud-api/     managed backend API (Hono on Cloudflare Workers)
  cloud-frontend/ cloud dashboard (Vite + React) — see visual-review gate below
  cloud-shared/  shared cloud backend: db (Drizzle), billing, services, types
  cloud-sdk/ cloud-routing/ cloud-infra/  cloud client SDK, model routing, IaC
  contracts/     on-chain contracts + ABIs
  security/ vault/ soc2-verify/  secrets, key management, compliance tooling
  os/ os-homepage/ robot/        device/OS images, OS landing, robotics
  plugin-host-shim*/ plugin-worker-runtime/ plugin-remote-manifest/
                 plugin loading shims for native/electrobun/ios/android/worker targets
  homepage/ docs/ docs-elizacloud-redirect/  marketing site, docs site, redirects
  examples/      30+ standalone runnable examples (each has its own README)
  benchmarks/    30+ evaluation suites (each has its own README + harness)

plugins/         runtime plugins and app plugins
  plugin-<model>/      openai, anthropic, google-genai, groq, openrouter, xai, ollama, …
  plugin-<connector>/  discord, telegram, farcaster, slack, imessage, whatsapp, x, …
  plugin-native-*/     native device bridges (camera, contacts, calendar, location, …)
  plugin-local-inference/  on-device llama.cpp / omnivoice / whisper (git submodules under native/)
  plugin-sql/ plugin-localdb/ plugin-inmemorydb/  storage adapters
  plugin-companion/ plugin-documents/ plugin-lifeops/ plugin-health/ …  app plugins

scripts/         repo automation        patches/   dependency patches
skills/          runtime skill packages turbo.json knip.json  build + dead-code config
```

Every package and plugin carries its own `CLAUDE.md` / `AGENTS.md` (identical)
and `README.md`. **Read the package-local doc first** — it lists that package's
layout, exports, scripts, env vars, and gotchas.

## Runtime architecture in 60 seconds

- **`@elizaos/core`** is the framework: the agent loop, the plugin model, and
  the message / memory / state primitives, with a model-agnostic LLM layer.
  If your code depends on `@elizaos/core`, you are using the framework.
- **`@elizaos/agent`** wires a runnable agent: `AgentRuntime`, the plugin
  loader, and the default plugin map.
- A **plugin** is `src/index.ts` exporting a `Plugin` object that registers:
  - **actions** — things the agent can *do* (validate + handler),
  - **providers** — context injected into the prompt,
  - **services** — long-lived singletons (clients, schedulers, connectors),
  - **evaluators** — post-response processing,
  - plus routes, events, and model handlers.
- **`@elizaos/app-core`** hosts the HTTP API + dashboard that runs agents.
- The **`elizaos` CLI** is intentionally minimal: scaffolding (`create`),
  info, and template upgrades. Project/plugin scaffolds live in
  `packages/elizaos/templates/` (`min-project`, `min-plugin` have `SCAFFOLD.md`
  contracts).

To build on the runtime from your own TypeScript with no CLI/UI, import
`@elizaos/core` directly — see `packages/examples/` (30+ standalone references).

## Repo-wide conventions

- **Logger only, never `console`** in server code. Use the structured logger,
  prefix messages with `[ClassName]`, attach context objects on errors.
- **ESM only.** No CommonJS.
- **No business computation in proxy/route layers.** Derive values in
  use-cases and return DTO fields the client just renders. Clients display,
  never compute.
- **DTO fields are required by default;** don't paper over a broken pipeline
  with `?? 0` or `as` casts.
- Keep weak types (`any` / `unknown` / unsafe casts) out; validate at runtime
  boundaries and type the validated result.

## Cloud frontend visual review — REQUIRED for any UI change in `packages/cloud-frontend/`

Any change in `packages/cloud-frontend/` (or a shared package whose UI bleeds
into it) MUST pass the screenshot + manual-review loop before it is "done":

```bash
bun run --cwd packages/cloud-frontend audit:cloud
```

This walks every route in `src/App.tsx` (desktop + mobile, rest + hover), logs
in with the synthetic injected-ethereum JWT, captures the populated UI, and
auto-stubs `aesthetic-audit-output/manual-review/<slug>.md` per route. Fill in
the verdict (`good` · `needs-work` · `needs-eyeball` · `broken`) for every page
you touched or can reach via shared layout/theme/components.

- No page may stay `needs-work` / `broken` when a UI task is declared done.
- Iterate the loop ≥5× for any meaningful redesign.
- Orange is accent only; no blue anywhere; orange-resting → darker-orange hover
  (never orange→black). Full rules: `packages/cloud-frontend/AGENTS.md`,
  `packages/cloud-frontend/docs/HOVER_SYSTEM.md`.

The product design language (colors, type, layout, do/don't) is `DESIGN.md`.

## LifeOps + health: one scheduler, structural behavior

`@elizaos/plugin-personal-assistant` and `@elizaos/plugin-health` share one
scheduled-item architecture. Reminders, check-ins, follow-ups, watchers,
recaps, approvals, and outputs are all `ScheduledTask` records routed through a
single runner (`plugins/plugin-personal-assistant/src/lifeops/scheduled-task/runner.ts`),
which pattern-matches on structural fields (`kind`, `trigger`, `shouldFire`,
`completionCheck`, `pipeline`, …), never on `promptInstructions` text. Health
contributes through registries; LifeOps does not import its internals.

**Do not add:** a second LifeOps scheduling mechanism, a second knowledge-graph
store (use `EntityStore` / `RelationshipStore`), behavior driven by
`promptInstructions` string content, a `boolean` return from a connector
dispatch (use the typed `DispatchResult`), or an identity-merge that bypasses
the merge engine. Architecture, frozen contracts, and contribution paths live in
`plugins/plugin-personal-assistant/README.md` and `plugins/plugin-health/README.md`.

## Contributing

Open an issue before a non-trivial PR. License: MIT (`LICENSE`). Security
policy: `SECURITY.md`.
