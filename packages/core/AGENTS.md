# @elizaos/core

The runtime heart of elizaOS: `AgentRuntime`, the plugin abstractions (actions / providers / evaluators / services / models / routes / events), the canonical type system, and the supporting subsystems (memory, search, settings, scheduling, prompts). Almost every other `@elizaos/*` package and plugin imports from here.

## Role

`@elizaos/core` defines the contracts an Eliza agent runs on and the runtime that executes them. Plugins implement `Plugin` and the runtime wires their actions/providers/evaluators/services into the message-handling loop. Consumed by `@elizaos/agent` (which also hosts the HTTP API server), `@elizaos/app-core` (the API + dashboard host), and every plugin. It builds to three targets (Node, browser, edge) via conditional exports — keep Node-only code out of the browser/edge entries.

## Layout

```
src/
  index.ts              Default barrel — re-exports index.node and security helpers
  index.node.ts         Full Node API surface (the real export list — start here)
  index.browser.ts      Browser-safe subset (no fs/process-bound modules)
  index.edge.ts         Edge-runtime subset
  runtime.ts            AgentRuntime class and lifecycle orchestration; navigate by symbol
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
                        pairing, pairing-integration, pairing-migration, hook, optimized-prompt,
                        optimized-prompt-resolver, tool-policy, trajectories, trajectory-export, trajectory-types,
                        triggerScheduling, approval, embedding, followUp, analysis-mode-handler, agentEvent,
                        runtime-capability-service, setup-cli, setup-rpc, setup-state
  features/             Self-contained capability bundles, each its own dir:
                        basic-capabilities (the core action/provider/evaluator/service bundle),
                        advanced-capabilities, advanced-memory, advanced-planning, approvals, autonomy, ballots,
                        documents, messaging (triage), oauth, payments, plugin-config, plugin-manager,
                        secrets, sub-agent-credentials, trajectories, trust, working-memory
  actions/              Action plumbing: action-schema, to-tool, validate-tool-args, subaction-dispatch
  providers/            First-party providers (setup-progress, skill-eligibility, linked-identities, ...)
  schemas/              Drizzle table schemas + character schema. schemas/index.ts: buildBaseTables, BaseTables
  database/             inMemoryAdapter (IDatabaseAdapter fallback used when ALLOW_NO_DATABASE)
  contracts/            Runtime-owned contracts plus topology, routing, first-run, and wallet adapters
  generated/            Build-time generated action/provider/evaluator docs + spec-helpers (do not hand-edit)
  i18n/                 validation + action-search keyword data (some generated; see prebuild)
  security/             KMS adapters, MCP config validation, spawn policy, redaction, and content guards
  sensitive-requests/   Sensitive request policy helpers
  network/              Canonical SSRF/IP policy, DNS pinning, and guarded fetch transport
  markdown/  media/     markdown IR/chunking; media fetch + mime/type detection
  testing/              Test harness exports (live-provider, integration-runtime, http, mocks) — `@elizaos/core/testing`
  capabilities/         Runtime capability index
  connectors/           Connector abstractions (account-manager, connector-config, oauth-role, privacy)
  plugins/              Plugin-related helpers
  registries/           Registry utilities
  sessions/             Session management
  sandbox/              Sandbox policy
  scheduled-task/       Scheduled task helpers
  validation/           Input validation utilities
  constants/            Shared constants
  api/                  API helpers
  owner-state/          Owner state tracking
  messaging/            Messaging utilities
  search.ts             In-memory/embedding search utilities
  utils.ts  utils/      Shared helpers: prompts (composePromptFromState, parseKeyValueXml), deterministic hashing, state/optimization dirs, batch-queue,
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

Subpath entries (see `package.json` `exports`): `@elizaos/core/node`,
`@elizaos/core/browser`, `@elizaos/core/roles`, `@elizaos/core/testing`,
`@elizaos/core/network`, `@elizaos/core/atomic-json`,
`@elizaos/core/security/mcp-server-config`, `@elizaos/core/security/kms`,
`@elizaos/core/security/spawn-env-policy`, and `@elizaos/core/services/*`.

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
bun run --cwd packages/core typecheck     # generate keywords, then tsc --noEmit
bun run --cwd packages/core lint          # biome check --write ./src
bun run --cwd packages/core format        # biome format --write ./src
bun run --cwd packages/core clean         # remove dist + emitted src artifacts
```

`prebuild` builds logger and cloud-routing, then generates `src/i18n/generated/validation-keyword-data.ts` if missing. Runtime-owned contracts are compiled with core.

## Config / env vars

Read by the runtime (see README for the full WHY of each):
- `LOG_LEVEL`, `LOG_JSON_FORMAT`, `LOG_FILE` — logger behavior (`src/logger.ts`).
- `SECRET_SALT` — encryption salt, read by `getSalt()` in `src/settings.ts` (`ELIZA_ALLOW_DEFAULT_SECRET_SALT` overrides the production non-default check).
- `ALLOW_NO_DATABASE` — fall back to `InMemoryDatabaseAdapter` on `initialize()` when no adapter is provided (`runtime.ts`).
- `SHOULD_RESPOND_MODEL` (`small`/`large`, `services/message.ts`), `BASIC_CAPABILITIES_KEEP_RESP` (`services/message.ts`) — message/basic-capabilities behavior.
- `ELIZA_BOT_NOISE_TRIAGE` (`services/message/bot-noise-triage.ts`) — set `0` to disable the TEXT_SMALL pre-gate that triages unaddressed bot/webhook group messages before the Stage 1 RESPONSE_HANDLER call (default on).
- `ELIZA_STAGE1_GROUP_TRIAGE` (`services/message/stage1-prompt-tier.ts`) — set `0` to disable the compact Stage 1 instruction tier for unaddressed group messages and always render the full rule block (default on).
- `AUTONOMY_INTERVAL_MS` (`features/autonomy/service.ts`) — canonical positive decimal integer cadence in milliseconds, clamped to 5,000–600,000; malformed or unset values use 30,000.
- `AUTONOMY_MODEL_SIZE` (`features/autonomy/service.ts`) — autonomy model tier, exactly `small` or `large`; malformed or unset values use `large`.
- Prompt-batcher knobs (all `PROMPT_BATCHER_*`, read in `runtime.ts`): `PROMPT_BATCHER_BATCH_SIZE`, `PROMPT_BATCHER_MAX_DRAIN_INTERVAL_MS`, `PROMPT_BATCHER_MAX_SECTIONS_PER_CALL`, `PROMPT_BATCHER_PACKING_DENSITY`, `PROMPT_BATCHER_MAX_TOKENS_PER_CALL`, `PROMPT_BATCHER_MAX_PARALLEL_CALLS`, `PROMPT_BATCHER_MODEL_SEPARATION`.
- `ELIZA_STATE_DIR` — state-dir resolution (`utils/state-dir.ts`); `ELIZA_WORKSPACE_DIR` — workspace folder (`utils/workspace-folder-config.ts`).
- `ELIZA_TRAJECTORY_LOGGING` — canonical trajectory persistence gate for both file and DB recorders (`runtime/trajectory-gate.ts`): truthy enables; non-empty falsey disables; blank is unset. Defaults are on for dev/unset `NODE_ENV`, off for `NODE_ENV=test|production`. `ELIZA_TRAJECTORY_RECORDING` is the legacy alias, and `ELIZA_DISABLE_TRAJECTORY_LOGGING=1` is the hard opt-out.

Prefer the canonical env reader in `utils/read-env.ts` over raw `process.env` (it handles legacy aliases).

### Setting / env resolution — precedence & the multi-tenant rule

Two canonical helpers own all setting/env resolution; everything else delegates:

| Helper | Source order | Use when |
| --- | --- | --- |
| `runtime.getSetting(key)` (`runtime.ts`) | character secrets → character settings → `settings.extra` → `settings.secrets` → `character.env.vars` → the constructor-provided `settings` map. **Never `process.env`.** | Inside the runtime / framework code. |
| `readEnv(key, opts)` (`utils/read-env.ts`) | `process.env[key]` (trimmed; empty string treated as unset) → `defaultValue`. | Reading an env var with no runtime in scope. |
| `resolveSetting(runtime, key, opts)` (`utils/resolve-setting.ts`) | `runtime.getSetting(key)` (coerced to string) → `readEnv(key)` → `defaultValue`. | Single-tenant / headless plugins that still want a dotenv fallback. |

**Resolution order:** runtime/character setting → env alias → default. The
per-agent runtime value always wins; the env fallback is the deployment default.

**WHY core `getSetting()` deliberately does NOT read `process.env`:** in a
multi-tenant process many agents share one OS environment. If `getSetting()`
fell through to `process.env`, a host secret (`OPENAI_API_KEY`,
`POSTGRES_URL`, …) set for the *box* would silently leak into *every* agent,
including ones the operator never granted it to. Keeping `getSetting()`
per-agent makes each agent's config explicit and isolated. `resolveSetting`
re-adds an opt-in env fallback for single-tenant/headless plugins **without**
changing `getSetting()` semantics — multi-tenant hosts that never call it are
unaffected.

**Host obligation (how to make dotenv values visible to `getSetting()`):**
because `getSetting()` reads the constructor-provided `settings` map and not
`process.env`, a host that wants `.env` / `process.env` values honored must fold
them into the runtime's settings at construction. `getBasicCapabilitiesSettings(character, env)`
(`runtime-composition.ts`) does exactly this — it flattens `character.settings`,
`character.secrets`, and `env` into the `Record<string,string>` handed to
adapter factories and the `AgentRuntime` constructor. Construct the runtime with
those settings and dotenv is honored; skip it and only character config is
visible.

## How to extend

- **Add an action/provider/evaluator/service to the built-in bundle:** implement against the `Action`/`Provider`/`Evaluator`/`Service` types in `types/`, then add it to the relevant array in `src/features/basic-capabilities/index.ts` (`basicActions`, `basicProviders`, `basicEvaluators`, `basicServices`). Most new capabilities should live in their own plugin package instead of here.
- **Add a runtime type/contract:** define it under `src/types/<area>.ts` or the owning `src/contracts/` domain and export it through the narrowest stable subpath. Cross-host contracts that do not belong to the runtime live under `@elizaos/shared/contracts`.
- **Add a DB table:** extend the schema in `src/schemas/` and wire it into `buildBaseTables` (`schemas/index.ts`); adapters in plugin-sql/localdb materialize it.
- **Touching the message loop:** the order is provider → model → action → evaluator. Logic lives in `src/runtime/` (`message-handler.ts`, `planner-loop.ts`, `turn-controller.ts`) and `runtime.ts`. Validated model output goes through `runtime/validated-model-call.ts`.
- **Browser/edge surface:** if your code is Node-only (fs, process, native deps), export it from `index.node.ts` only — never add it to `index.browser.ts` / `index.edge.ts`.

## Conventions / gotchas

- `index.node.ts` is the source of truth for the root public surface; narrow contract consumers should prefer `@elizaos/core/contracts/*` subpaths to avoid barrel collisions.
- Three build targets share source — Node-only imports in shared modules break the browser/edge bundles. Verify with `build:node` vs full `build`.
- The model-output contract is `<response>` XML (with `<actions>`/`<providers>`/`<text>`); plain text is tolerated and treated as a `REPLY`.
- DB mutation methods on `IDatabaseAdapter` return `Promise<boolean>` so callers can distinguish success/failure (`types/database.ts`).
- The task system (`services/task.ts`, `services/task-scheduler.ts`) is the single place scheduled work runs; only tasks tagged `queue` are polled. Three modes: local timer, per-daemon (`startTaskScheduler`), serverless (`{ serverless: true }` + `runDueTasks()`).
- Document reads use `roomId` as the single room entitlement and join it to the requester's current room set inside the adapter. `directGrantEntityIds` is a bounded, validated read exception that remains valid without room membership; it never opens `agent-private` documents and never grants mutation authority. Only the dedicated adapter CAS may replace grants: OWNER on any valid document, or a current room ADMIN on global and user-private documents, with every grantee validated in the current agent tenant. Malformed or duplicate grant arrays make the parent unreadable.
- `runtime.ts` is intentionally large and load-bearing; navigate by symbol and
  ownership boundary rather than reading it top to bottom or adding another
  unrelated responsibility.
- `src/generated/` and parts of `src/i18n/generated/` are build artifacts; regenerate via prebuild rather than editing.
- Repository-wide rules and evidence requirements are inherited from the root
  [`CLAUDE.md`](../../CLAUDE.md).

## Package completion evidence

Follow the repository-wide definition of done in the root guide. For core
changes, additionally capture and inspect:

- a live-model trajectory for any changed provider → model → action → evaluator
  path, including raw model output and every tool result;
- structured logs and the resulting memory, entity, relationship, task,
  trajectory, or database artifacts; and
- both the Node-only build and the full multi-target build whenever a shared
  export or runtime dependency changes.
