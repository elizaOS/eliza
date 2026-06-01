# @elizaos/core

The runtime heart of elizaOS: `AgentRuntime`, the plugin abstractions (actions / providers / evaluators / services / models / routes / events), the canonical type system, and the supporting subsystems (memory, search, settings, scheduling, prompts). Almost every other `@elizaos/*` package and plugin imports from here.

## Role

`@elizaos/core` defines the contracts an Eliza agent runs on and the runtime that executes them. Plugins implement `Plugin` and the runtime wires their actions/providers/evaluators/services into the message-handling loop. Consumed by `@elizaos/agent`, `@elizaos/server`, the CLI, and every plugin. It builds to three targets (Node, browser, edge) via conditional exports — keep Node-only code out of the browser/edge entries.

## Layout

```
src/
  index.ts              Default barrel — re-exports index.node + a few @elizaos/contracts type shims
  index.node.ts         Full Node API surface (the real export list — start here)
  index.browser.ts      Browser-safe subset (no fs/process-bound modules)
  index.edge.ts         Edge-runtime subset
  runtime.ts            AgentRuntime class (~700+, `class AgentRuntime implements IAgentRuntime`); the central orchestrator
  runtime-composition.ts  loadCharacters / createRuntimes / settings merge (Node-only boot helpers)
  runtime-env.ts        Runtime environment + state resolution
  plugin.ts             Plugin load/validate/resolve: loadPlugin, resolvePlugins, validatePlugin, resolvePluginDependencies
  plugin-lifecycle.ts   Plugin register/unload/reload + ownership tracking
  runtime/              Message loop internals: message-handler, planner-loop, turn-controller, action-catalog,
                        action-retrieval/routing/tiering, context-* (registry/renderer/gates), evaluator,
                        validated-model-call, response-grammar, system-prompt, sub-planner, trajectory-recorder
  types/                Canonical type system. types/index.ts is the barrel; types/runtime.ts has IAgentRuntime;
                        plugin.ts, model.ts, memory.ts, state.ts, service.ts, task.ts, events.ts, schema*.ts, etc.
  services/             Built-in services: task / task-scheduler, evaluator, message, relationships,
                        pairing, hook, optimized-prompt, tool-policy, trajectories, triggerScheduling, approval
  features/             Self-contained capability bundles, each its own dir:
                        basic-capabilities (the core action/provider/evaluator/service bundle),
                        advanced-capabilities, advanced-memory, advanced-planning, documents, messaging (triage),
                        payments, plugin-manager, secrets, oauth, trust, autonomy, working-memory, ballots
  actions/              Action plumbing: action-schema, to-tool, validate-tool-args, subaction-dispatch
  providers/            First-party providers (setup-progress, skill-eligibility, linked-identities, ...)
  schemas/              Drizzle table schemas + character schema. schemas/index.ts: buildBaseTables, BaseTables
  database/             inMemoryAdapter (IDatabaseAdapter fallback used when ALLOW_NO_DATABASE)
  contracts/            Re-exports/adapters over @elizaos/contracts (cloud-topology, first-run-options, service-routing, wallet)
  generated/            Build-time generated action/provider/evaluator docs + spec-helpers (do not hand-edit)
  i18n/                 validation + action-search keyword data (some generated; see prebuild)
  security/             redact, ssrf-adjacent input policy, spawn-env-policy, external-content, incoming-message-security
  network/              SSRF guard + secure fetch (fetch-guard, ssrf)
  markdown/  media/     markdown IR/chunking; media fetch + mime/type detection
  testing/              Test harness exports (live-provider, integration-runtime, http, mocks) — `@elizaos/core/testing`
  search.ts             In-memory/embedding search utilities
  utils.ts  utils/      Shared helpers: prompts (composePromptFromState, parseKeyValueXml), batch-queue,
                        confirmation, read-env, state-dir, streaming, environment, plugin-loader
build.ts                Custom bun-based multi-target build (Node / browser / edge + d.ts generation)
scripts/perf-settings.ts, scripts/run-e2e-smoke.mjs
```

## Key exports / surface

From `@elizaos/core` (`index.node.ts`):
- `AgentRuntime` — the runtime, `implements IAgentRuntime`.
- Plugin machinery: `loadPlugin`, `resolvePlugins`, `validatePlugin`, `isValidPluginShape`, `normalizePluginName`, `resolvePluginDependencies`.
- `logger` (re-exported from `./logger`) — the structured logger all packages use.
- Type contracts: `Plugin`, `Action`, `Provider`, `Evaluator`, `Service`, `IAgentRuntime`, `IDatabaseAdapter`, `Memory`, `State`, `Character`, `ModelType`, `UUID`, plus everything in `types/`.
- Built-in capability bundle: `basicCapabilities` / `basicActions` / `basicProviders` / `basicEvaluators` / `basicServices` (from `features/basic-capabilities/index.ts`).
- Boot/composition (Node): `loadCharacters`, `createRuntimes`, `buildBaseTables`, `InMemoryDatabaseAdapter`.
- Prompt + model helpers: `composePromptFromState`, `parseKeyValueXml`, `callModelWithValidation`, `parseAndValidate`.

Subpath entries (see `package.json` `exports`): `@elizaos/core/node`, `@elizaos/core/browser`, `@elizaos/core/roles`, `@elizaos/core/testing`, `@elizaos/core/services/*`.

This package does NOT export a `corePlugin` singleton — the foundational actions/providers/evaluators/services live in `features/basic-capabilities` and are exported as the `basic*` bundles above.

## Commands

```bash
bun run --cwd packages/core build         # multi-target build via build.ts (Node + browser + edge + d.ts)
bun run --cwd packages/core build:node    # Node target only
bun run --cwd packages/core build:watch   # watch build (alias: dev)
bun run --cwd packages/core test          # vitest run (via ../scripts/run-vitest.mjs)
bun run --cwd packages/core test:watch    # vitest watch
bun run --cwd packages/core test:coverage # vitest with v8 coverage
bun run --cwd packages/core test:e2e      # Playwright (playwright.config.ts)
bun run --cwd packages/core test:e2e:smoke
bun run --cwd packages/core typecheck     # tsgo --noEmit -p ./tsconfig.json
bun run --cwd packages/core lint          # biome check --write ./src
bun run --cwd packages/core format        # biome format --write ./src
bun run --cwd packages/core clean         # remove dist + emitted src artifacts
```

`prebuild` builds `@elizaos/contracts` and generates `src/i18n/generated/validation-keyword-data.ts` if missing. Depends on workspace packages `@elizaos/contracts` and `@elizaos/prompts`.

## Config / env vars

Read by the runtime (see README for the full WHY of each):
- `LOG_LEVEL`, `LOG_JSON_FORMAT`, `LOG_FILE` — logger behavior (`src/logger.ts`).
- `SECRET_SALT` — encryption salt (`src/secrets.ts`, `src/security/redact.ts`).
- `ALLOW_NO_DATABASE` — fall back to `InMemoryDatabaseAdapter` on `initialize()` when no adapter is provided.
- `SHOULD_RESPOND_MODEL` (`small`/`large`), `BASIC_CAPABILITIES_KEEP_RESP`, `DISABLE_MEMORY_CREATION`, `ALLOW_MEMORY_SOURCE_IDS` — message/basic-capabilities behavior.
- Prompt-batcher knobs: `PROMPT_BATCH_SIZE`, `PROMPT_MAX_DRAIN_INTERVAL_MS`, `PROMPT_MAX_SECTIONS_PER_CALL`, `PROMPT_PACKING_DENSITY`, `PROMPT_MAX_TOKENS_PER_CALL`, `PROMPT_MAX_PARALLEL_CALLS`, `PROMPT_MODEL_SEPARATION`.
- `ELIZA_STATE_DIR` — state-dir resolution (`utils/state-dir.ts`); `ELIZA_WORKSPACE_DIR` — workspace folder (`utils/workspace-folder-config.ts`).

Prefer the canonical env reader in `utils/read-env.ts` over raw `process.env` (it handles legacy aliases).

## How to extend

- **Add an action/provider/evaluator/service to the built-in bundle:** implement against the `Action`/`Provider`/`Evaluator`/`Service` types in `types/`, then add it to the relevant array in `src/features/basic-capabilities/index.ts` (`basicActions`, `basicProviders`, `basicEvaluators`, `basicServices`). Most new capabilities should live in their own plugin package instead of here.
- **Add a runtime type/contract:** define it under `src/types/<area>.ts` and export from `src/types/index.ts`. If it should be shared with non-runtime consumers, prefer `@elizaos/contracts` and re-export via `src/contracts/`.
- **Add a DB table:** extend the schema in `src/schemas/` and wire it into `buildBaseTables` (`schemas/index.ts`); adapters in plugin-sql/localdb materialize it.
- **Touching the message loop:** the order is provider → model → action → evaluator. Logic lives in `src/runtime/` (`message-handler.ts`, `planner-loop.ts`, `turn-controller.ts`) and `runtime.ts`. Validated model output goes through `runtime/validated-model-call.ts`.
- **Browser/edge surface:** if your code is Node-only (fs, process, native deps), export it from `index.node.ts` only — never add it to `index.browser.ts` / `index.edge.ts`.

## Conventions / gotchas

- `index.node.ts` is the source of truth for the public surface; `index.ts` just re-exports it plus a few `@elizaos/contracts` type shims (kept explicit to avoid d.ts ambiguity).
- Three build targets share source — Node-only imports in shared modules break the browser/edge bundles. Verify with `build:node` vs full `build`.
- The model-output contract is `<response>` XML (with `<actions>`/`<providers>`/`<text>`); plain text is tolerated and treated as a `REPLY`.
- DB mutation methods on `IDatabaseAdapter` return `Promise<boolean>` so callers can distinguish success/failure (`types/database.ts`).
- The task system (`services/task.ts`, `services/task-scheduler.ts`) is the single place scheduled work runs; only tasks tagged `queue` are polled. Three modes: local timer, per-daemon (`startTaskScheduler`), serverless (`{ serverless: true }` + `runDueTasks()`).
- `runtime.ts` is very large (~265 KB) — navigate by symbol, not by reading top-to-bottom.
- `src/generated/` and parts of `src/i18n/generated/` are build artifacts; regenerate via prebuild rather than editing.
- Repo-wide rules (logger-only, ESM, naming, architecture) are in the root [AGENTS.md](../../AGENTS.md) — not restated here.
