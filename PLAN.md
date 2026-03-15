# elizaOS v2.0.0 — Phased Build Plan

> **Branch:** `odi-want` · **Date:** 2026-03-10 · **Status:** Builds pass, tests mostly pass (twilio/blooio known failures)

---

## How to use this plan

Each phase is **self-contained and shippable**. Complete phases in order — later phases depend on earlier ones. Each phase lists:

- **Goal** — what you're delivering
- **Tasks** — concrete, checkboxable work items
- **Definition of done** — how you know you're finished
- **Traps & pitfalls** — things that will bite junior devs or low-param models

---

## Current state (Phase 0 — already done)

- [x] Monorepo builds (`bun run build` green)
- [x] 239 packages in test scope; most pass
- [x] Convention script (`scripts/ensure-plugin-test-conventions.mjs`) guards vitest/rust/python test scripts
- [x] Core types extended: `State.data`, `Task` scheduling, approval service, autonomy service
- [x] Plugin test fixes: s3-storage, imessage, nextcloud-talk, elevenlabs, edge-tts, local-embedding, bluebubbles, directives, roblox, rust-plugin-starter
- [x] `ARCHITECTURE.md`, `CORE_CONCEPTS.md`, `PLUGIN_DEVELOPMENT.md` docs exist
- [x] `OPTIMIZATION_TODOS.md` tracks file-by-file cleanup (~60% checked off)

**Known debt:**
- `plugin-twilio` tests fail (mock missing `validateMessagingAddress` export)
- `plugin-blooio` tests fail (14 tests)
- `OPTIMIZATION_TODOS.md` has ~40% unchecked files (basic-capabilities providers, database, services, types, utils)

---

## Phase 1 — Test suite green + CI guardrails

**Goal:** Every package's `test` task passes. No regressions slip through.

### Tasks

- [ ] **1.1 Fix plugin-twilio tests** — The `vi.mock("../../utils")` in `sendSms.test.ts` / `sendMms.test.ts` doesn't auto-export `validateMessagingAddress`. Add it to the mock factory.
- [ ] **1.2 Fix plugin-blooio tests** — 14 failures; likely a mock or type mismatch introduced by core type changes. Read the test output, fix mocks.
- [ ] **1.3 Run full `bun run test` end-to-end** — Confirm 0 failures. If new failures surface, fix them before moving on.
- [ ] **1.4 Add CI workflow** — Create `.github/workflows/test.yml`:
  - Trigger on push to `odi-want` and PRs targeting it
  - Steps: `bun install`, `bun run build`, `bun run test`
  - Add the `ensure-plugin-test-conventions:check` step so CI fails if a plugin's test script drifts
- [ ] **1.5 Add pre-commit hook (optional)** — `npx husky` + `lint-staged` to run `bun run build` on changed packages before commit

### Definition of done

`bun run test` exits 0. CI workflow file exists and would pass on a clean runner.

### Traps & pitfalls

| Trap | Why it bites you | Fix |
|------|-----------------|-----|
| **`vi.mock` doesn't auto-export new symbols** | If the real module adds a new export after the mock was written, vitest won't include it. Tests get `[vitest] No "foo" export is defined on the mock`. | Always add new exports to the mock factory, or use `vi.mock("...", async () => ({ ...(await vi.importActual("...")), overriddenFn: vi.fn() }))`. |
| **`--passWithNoTests` hides real problems** | A plugin with `--passWithNoTests` will silently pass even if all test files were accidentally deleted. | Only use it for plugins that genuinely have no tests yet. Once you add tests, remove the flag. |
| **Turbo cache masks failures** | Turbo caches test results. If you fix a file but turbo serves a stale "pass", you'll think it's fixed when it isn't. | Run with `--force` when debugging: `bun run test -- --force`. |
| **`bun run test` concurrency=3** | The root script sets `--concurrency 3`. On a machine with <8GB RAM, plugin-sql PGLite tests can OOM. | If you see `Killed` or `SIGKILL`, lower concurrency to 1 or increase swap. |
| **Test isolation: shared `/tmp` databases** | Several plugin-sql tests create PGLite databases in `/tmp/eliza-migration-test-*`. Parallel runs can collide. | Each test should use a unique directory (most already do via timestamp, but watch for hardcoded paths). |

---

## Phase 2 — Core runtime hardening

**Goal:** The TypeScript core (`packages/typescript/src/`) is clean, well-tested, and has no performance foot-guns.

### Tasks

- [ ] **2.1 Complete OPTIMIZATION_TODOS.md** — Work through the remaining unchecked files:
  - `basic-capabilities/providers/*` (13 files)
  - `database/inMemoryAdapter.ts`
  - `services/*` (7 files)
  - `types/*` (17 files)
  - `utils/*` (9 files)
  - Root files: `database.ts`, `entities.ts`, `logger.ts`, `runtime.ts`, `utils.ts`, etc.
  - For each: review for unnecessary allocations, redundant iterations, missing early returns, and type safety
- [ ] **2.2 runtime.ts audit** — This file is 5,533 lines. It needs:
  - Extract `composeState` into its own module (it's ~300 lines of provider orchestration)
  - Extract plugin registration logic into `plugin-registry.ts`
  - Extract the `ensureConnection` / `ensureWorldExists` / `ensureRoomExists` cluster
  - Keep `runtime.ts` as the orchestrator that delegates to these modules
- [ ] **2.3 message.ts audit** — 2,228 lines. Extract:
  - `shouldRespond` logic into a standalone function/module
  - Multi-step execution loop into its own module
  - Streaming response assembly
- [ ] **2.4 Add missing unit tests** — Target: >80% line coverage on:
  - `runtime.ts` (especially `composeState`, `processActions`, `evaluate`)
  - `services/task.ts` (task scheduling, repeat tasks, dueAt logic)
  - `services/approval.ts`
  - `database/inMemoryAdapter.ts`
- [ ] **2.5 Type safety sweep** — Grep for `as any`, `// @ts-ignore`, `// @ts-expect-error` in `packages/typescript/src/` (excluding tests). Fix or document each one.

### Definition of done

All items in `OPTIMIZATION_TODOS.md` checked. `runtime.ts` < 2,000 lines. Test coverage >80% on core services. Zero `as any` in non-test code (or each one has a justifying comment).

### Traps & pitfalls

| Trap | Why it bites you | Fix |
|------|-----------------|-----|
| **Extracting from runtime.ts breaks circular imports** | `runtime.ts` imports types that import from files that import `AgentRuntime`. Moving code out can create import cycles. | Use the `types/` barrel (`types/index.ts`) for type-only imports. Use `import type` everywhere possible. If a circular dep appears, break it with a callback/interface pattern. |
| **`composeState` caching is keyed by `message.id`** | If you refactor `composeState` and accidentally change the cache key, every provider runs twice per message. Performance tanks. | Keep the cache key as `message.id`. Write a test that calls `composeState` twice with the same message and asserts providers only ran once. |
| **`InMemoryDatabaseAdapter` is used in ALL unit tests** | If you break it, every test in the repo fails. | Never refactor `inMemoryAdapter.ts` without running the full test suite. Add a dedicated test file for it first. |
| **`as any` removal can cascade** | Removing one `as any` can surface 10+ type errors downstream. | Fix one `as any` at a time. Run `tsc --noEmit` after each removal. Don't batch. |
| **Provider `position` ordering is load-bearing** | Providers run sorted by `position`. If you refactor and accidentally change the sort, prompts get assembled in wrong order. | Add a test that registers providers with positions [30, 10, 20] and asserts they execute in [10, 20, 30] order. |

---

## Phase 3 — Plugin quality & consistency

**Goal:** Every plugin builds, tests, and follows the same conventions. No plugin is a "special snowflake."

### Tasks

- [ ] **3.1 Audit all 93 plugins for build health** — Run `bun run build` with `--force` and capture per-plugin results. Create a spreadsheet/checklist.
- [ ] **3.2 Standardize tsconfig** — Every plugin's `tsconfig.json` should:
  - Extend a shared `tsconfig.plugin.json` at the repo root (or `plugins/tsconfig.plugin.json`)
  - Include `"types": ["node"]` (prevents the uuid type-def ghost)
  - Use `"skipLibCheck": true` for faster builds
  - Set `"rootDir": "src"` and `"outDir": "dist"`
- [ ] **3.3 Standardize package.json scripts** — Run `ensure-plugin-test-conventions.mjs` and commit. Then verify:
  - Every plugin has `build`, `test`, `typecheck` scripts
  - `test` uses `vitest run --passWithNoTests` (or a real test command)
  - No plugin uses `elizaos test` (it's broken for plugins without dist)
- [ ] **3.4 Add at least 1 test per plugin** — For plugins with zero tests, add a minimal "plugin exports the right shape" test:
  ```ts
  import { myPlugin } from "../src/index";
  test("plugin has required fields", () => {
    expect(myPlugin.name).toBeDefined();
    expect(typeof myPlugin.name).toBe("string");
  });
  ```
- [ ] **3.5 Fix plugin-sql schema-builder type errors** — The `schema-builders/mysql.ts` and `schema-builders/pg.ts` have spread/tuple type errors. Fix them so `bun run build` passes with strict types.
- [ ] **3.6 Document plugin conventions** — Update `docs/PLUGIN_DEVELOPMENT.md` with:
  - Required scripts and their purposes
  - tsconfig conventions
  - Testing requirements
  - How to add a database schema

### Definition of done

`bun run build` and `bun run test` both pass with `--force`. Every plugin has ≥1 test. `ensure-plugin-test-conventions:check` passes in CI.

### Traps & pitfalls

| Trap | Why it bites you | Fix |
|------|-----------------|-----|
| **Shared tsconfig `extends` path resolution** | `"extends": "../../tsconfig.plugin.json"` resolves relative to the tsconfig file, not the workspace root. Nested plugins (e.g., `plugins/plugin-foo/typescript/tsconfig.json`) need `"../../../tsconfig.plugin.json"`. | Use a consistent nesting depth or put the base config in `plugins/tsconfig.plugin.json` (one level up from each plugin). |
| **`skipLibCheck: true` hides real type errors in `.d.ts` files** | If a plugin ships broken declarations, consumers won't catch it until they disable `skipLibCheck`. | Use `skipLibCheck` only in the plugin's own tsconfig. The consuming app should NOT set it. |
| **`elizaos test` vs `vitest run`** | `elizaos test` is the CLI wrapper that runs e2e tests expecting `dist/` to exist. Most plugins don't have e2e tests. Using it as the `test` script causes failures. | Use `vitest run` for unit/component tests. Only use `elizaos test` for packages that have actual e2e test files. |
| **Plugin `init()` can throw and break the whole runtime** | If a plugin's `init()` throws (e.g., missing env var), `runtime.initialize()` fails and no agent starts. | Always wrap env-var checks in `init()` with clear error messages. Never throw for optional config — log a warning and disable the feature. |
| **Monorepo `workspace:*` version resolution** | Plugins depend on `"@elizaos/core": "workspace:*"`. If you accidentally publish with this, npm consumers get a broken package. | The publish pipeline must replace `workspace:*` with the actual version. Verify this in the release script. |

---

## Phase 4 — Developer experience & onboarding

**Goal:** A new developer can clone the repo, build, test, and create a plugin in under 30 minutes.

### Tasks

- [ ] **4.1 Root README overhaul** — The root README should have:
  - One-command setup: `bun install && bun run build && bun run test`
  - Architecture diagram (text-based, mermaid, or link to canvas)
  - "Create your first plugin" quick-start (link to `examples/_plugin/`)
  - Links to all docs in `docs/`
- [ ] **4.2 `bun run create-plugin` script** — A scaffolding script that:
  - Prompts for plugin name
  - Creates `plugins/plugin-<name>/` with the standard structure
  - Adds it to the workspace
  - Creates a minimal test file
  - Runs `bun install`
- [ ] **4.3 Example cleanup** — 44 examples exist. Audit and:
  - Archive examples that don't build or are abandoned (move to `examples/_archive/`)
  - Ensure every active example has a README with setup instructions
  - Ensure every active example builds with `bun run build`
- [ ] **4.4 Contributing guide** — Create `CONTRIBUTING.md`:
  - Branch naming conventions
  - PR template
  - How to run tests for just your plugin
  - How to add a new plugin
  - How to add a new example
- [ ] **4.5 Error messages audit** — Grep for `throw new Error` in core. Every error should:
  - Include the function/module name
  - Include actionable guidance ("did you forget to register a database adapter?")
  - Never expose internal stack traces to end users

### Definition of done

A developer unfamiliar with the codebase can follow the README, create a plugin, and run its tests without asking for help.

### Traps & pitfalls

| Trap | Why it bites you | Fix |
|------|-----------------|-----|
| **`bun install` takes 2+ minutes on cold cache** | New devs think it's broken and ctrl-C. | Add a note in README: "First install takes ~2 minutes. Subsequent installs are <10s." |
| **Node version mismatch** | Some plugins use Node APIs not available in older versions. Bun's Node compat layer also has gaps. | Add `engines` to root `package.json`: `"node": ">=20"`, `"bun": ">=1.1"`. Add a `.node-version` file. |
| **Examples reference `workspace:*` deps** | If someone copies an example outside the monorepo, `workspace:*` won't resolve. | Add a note in each example README: "This example must be run inside the elizaOS monorepo." |
| **Scaffolding script creates files but forgets `bun install`** | The new plugin exists but isn't linked in the workspace. Imports fail. | Always run `bun install` at the end of the scaffold script. |
| **`CONTRIBUTING.md` goes stale** | Nobody updates it when conventions change. | Add a CI check that verifies `CONTRIBUTING.md` mentions the current test command and branch conventions. Or keep it minimal and link to the docs/ folder. |

---

## Phase 5 — Performance & observability

**Goal:** The runtime is fast, measurable, and debuggable in production.

### Tasks

- [ ] **5.1 Benchmark suite** — Create `packages/typescript/src/__benchmarks__/`:
  - `composeState.bench.ts` — measure provider orchestration with 5, 10, 20 providers
  - `processActions.bench.ts` — measure action execution with mock actions
  - `messageHandling.bench.ts` — end-to-end message processing with in-memory adapter
  - Use `vitest bench` or `bun:test` benchmarks
- [ ] **5.2 Provider parallelization audit** — `composeState` runs providers "in parallel" but some providers depend on others' results. Audit for:
  - Providers that read `state.data.providers[otherProvider]` — these have implicit ordering dependencies
  - Providers that make network calls — these should have timeouts
  - Add `provider.timeout` support (default 10s, configurable)
- [ ] **5.3 Memory/embedding queue optimization** — `queueEmbeddingGeneration` is fire-and-forget. Add:
  - Backpressure (max queue size)
  - Batch embedding calls (many embedding APIs support batch)
  - Metrics: queue depth, processing time, error rate
- [ ] **5.4 Structured logging** — The logger (`packages/typescript/src/logger.ts`) should:
  - Support structured JSON output (for production log aggregation)
  - Include `agentId`, `roomId`, `messageId` in every log line
  - Support log levels configurable per-plugin
- [ ] **5.5 OpenTelemetry integration** — Add optional tracing:
  - Span per message handling cycle
  - Span per provider execution
  - Span per action execution
  - Span per model call
  - Export to OTLP (configurable endpoint)

### Definition of done

Benchmark suite runs in CI (results tracked over time). Structured logging works. OTel traces can be viewed in Jaeger/Grafana when enabled.

### Traps & pitfalls

| Trap | Why it bites you | Fix |
|------|-----------------|-----|
| **Benchmarks are flaky in CI** | CPU-bound benchmarks vary ±30% on shared CI runners. | Track relative performance (ratio to baseline), not absolute times. Run benchmarks on dedicated hardware or use statistical significance tests. |
| **Provider timeout kills slow but correct providers** | A knowledge-retrieval provider might legitimately take 15s on a large corpus. | Make timeout configurable per-provider. Default 10s, but allow `provider.timeout = 30_000`. |
| **OTel dependency bloat** | `@opentelemetry/*` packages add ~5MB to node_modules. | Make OTel a peer dependency. Only import it dynamically when `OTEL_ENABLED=true`. |
| **Structured logging breaks existing log parsers** | If you switch from text to JSON, anyone grepping logs with `| grep "ERROR"` breaks. | Support both modes. Default to text in development, JSON in production (`LOG_FORMAT=json`). |
| **Batch embedding changes API semantics** | If you batch 10 embeddings and 1 fails, do you retry all 10 or just the 1? | Retry only the failed items. Return partial results. Log which items failed. |

---

## Phase 6 — Plugin ecosystem maturity

**Goal:** The top 20 most-used plugins are production-ready with comprehensive tests and docs.

### Tasks

- [ ] **6.1 Identify top 20 plugins** — By usage (downloads, GitHub issues, example references):
  - Likely: sql, openai, anthropic, discord, telegram, slack, knowledge, memory, browser, github, solana, evm, bluesky, farcaster, google-genai, ollama, local-ai, s3-storage, shell, mcp
- [ ] **6.2 Per-plugin hardening** — For each top-20 plugin:
  - [ ] Integration test with real (or realistic mock) API
  - [ ] Error handling: every API call has try/catch with meaningful error messages
  - [ ] Rate limiting: respect API rate limits, implement backoff
  - [ ] Configuration validation: use Zod schemas for env vars, fail fast with clear messages
  - [ ] README with: setup instructions, required env vars, example usage, troubleshooting
- [ ] **6.3 Plugin versioning strategy** — Decide:
  - Do plugins version independently or lock-step with core?
  - How do breaking changes in core propagate to plugins?
  - Document in `CONTRIBUTING.md`
- [ ] **6.4 Plugin registry/discovery** — The `plugin-plugin-manager` plugin exists. Ensure:
  - It can list available plugins
  - It can install a plugin at runtime
  - It validates plugin compatibility with the current core version

### Definition of done

Top 20 plugins each have: ≥5 tests, a README, Zod-validated config, and error handling on all external calls.

### Traps & pitfalls

| Trap | Why it bites you | Fix |
|------|-----------------|-----|
| **Integration tests need API keys** | CI doesn't have Anthropic/OpenAI/Discord keys. Tests fail or are skipped. | Use `describe.skipIf(!process.env.API_KEY)` for real-API tests. Have a separate CI job that runs integration tests with secrets. |
| **Rate limit backoff is exponential forever** | A bug causes infinite retries with exponential backoff. The process hangs. | Cap retries (default 3). Cap max backoff (default 60s). Add a circuit breaker. |
| **Zod validation in `init()` throws before the agent starts** | If you validate ALL env vars eagerly, a plugin for a service you don't use prevents startup. | Only validate env vars when the plugin's features are actually invoked. Or validate in `init()` but only warn, don't throw. |
| **Lock-step versioning means every plugin bumps on every core change** | Even plugins with zero changes get a new version. npm consumers see churn. | Use independent versioning with a compatibility matrix. Core exports a `CORE_VERSION` constant that plugins can check. |
| **`plugin-plugin-manager` can install malicious plugins** | Runtime plugin installation is a supply-chain attack vector. | Require plugins to be from a trusted registry. Add signature verification. Default to read-only (no runtime install) in production. |

---

## Phase 7 — Multi-language parity

**Goal:** Rust and Python runtimes can run the same agents as TypeScript.

### Tasks

- [ ] **7.1 Audit Python SDK** — `packages/python/`:
  - [ ] Does it implement the full `IAgentRuntime` surface?
  - [ ] Can it load TypeScript plugins via interop?
  - [ ] Are there tests for message handling, state composition, action execution?
  - [ ] Fix the `test_autonomy.py` and `test_runtime.py` issues identified earlier
- [ ] **7.2 Audit Rust runtime** — `packages/rust/`:
  - [ ] Does it implement the full `IAgentRuntime` surface?
  - [ ] WASM build: does it work in browser and Node?
  - [ ] Fix the failing assertion test (`!result.did_respond`)
- [ ] **7.3 Interop test suite** — `packages/interop/`:
  - [ ] TS → Rust plugin call (WASM)
  - [ ] TS → Python plugin call (subprocess IPC)
  - [ ] Round-trip: TS sends message → Rust plugin processes → TS gets result
- [ ] **7.4 Cross-language plugin template** — Update `examples/_plugin/rust/` and add `examples/_plugin/python/`:
  - Working build
  - Working tests
  - README with setup instructions

### Definition of done

A "hello world" agent can run with the same character file in TS, Rust, and Python. Cross-language plugin calls work in tests.

### Traps & pitfalls

| Trap | Why it bites you | Fix |
|------|-----------------|-----|
| **Python subprocess IPC is slow** | Each TS↔Python call spawns JSON serialization + subprocess communication. Latency adds up. | Use a persistent subprocess with a message queue (the current newline-delimited JSON approach). Batch calls where possible. |
| **Rust WASM binary size** | A naive Rust plugin compiles to 5MB+ WASM. Browser loading is slow. | Use `wasm-opt`, `lto = true`, `opt-level = "z"`. Strip debug info. Target `wasm32-unknown-unknown` with minimal std. |
| **Python version mismatch** | The repo assumes Python 3.11+ but some devs have 3.9. Pydantic v2 syntax fails. | Pin `python_requires >= "3.11"` in `pyproject.toml`. Add a version check in the test script. |
| **Interop type drift** | The TS types evolve but the Rust/Python types don't get updated. Calls fail at runtime with serialization errors. | Generate Rust/Python types FROM the TypeScript types (code generation). Or use protobuf/JSON Schema as the source of truth. |
| **`cargo test` requires Rust toolchain** | CI and dev machines may not have Rust installed. The test script fails. | Guard with `command -v cargo` check (already done for some plugins). Make Rust tests opt-in via env var. |

---

## Phase 8 — Production readiness

**Goal:** elizaOS can run agents in production with confidence.

### Tasks

- [ ] **8.1 Graceful shutdown** — `AgentRuntime` needs:
  - [ ] `shutdown()` method that: stops accepting new messages, drains in-flight messages, closes DB connections, stops services
  - [ ] Signal handlers (SIGTERM, SIGINT) that call `shutdown()`
  - [ ] Timeout on shutdown (force-kill after 30s)
- [ ] **8.2 Health checks** — Add a built-in `/health` endpoint:
  - [ ] Database connectivity
  - [ ] Model provider reachability
  - [ ] Memory/CPU usage
  - [ ] Queue depths (embedding, task scheduler)
- [ ] **8.3 Configuration validation** — At startup:
  - [ ] Validate all required env vars
  - [ ] Validate character file schema
  - [ ] Validate plugin compatibility
  - [ ] Print a clear startup summary: "Agent X loaded with plugins [A, B, C], database: postgres, model: openai"
- [ ] **8.4 Database migrations in production** — Ensure:
  - [ ] Migrations are idempotent (can run twice safely)
  - [ ] Migrations have rollback support (or at least are non-destructive)
  - [ ] Migration status is logged clearly
  - [ ] `--dry-run` flag shows what would change without applying
- [ ] **8.5 Security audit** — Review:
  - [ ] No secrets in logs (grep for `apiKey`, `token`, `secret` in log statements)
  - [ ] No secrets in error messages
  - [ ] Plugin sandboxing (plugins can't access other plugins' data without explicit permission)
  - [ ] Rate limiting on HTTP routes

### Definition of done

An agent can start, serve traffic, handle errors gracefully, shut down cleanly, and restart without data loss.

### Traps & pitfalls

| Trap | Why it bites you | Fix |
|------|-----------------|-----|
| **Shutdown doesn't wait for in-flight messages** | Agent gets SIGTERM, kills mid-response. User sees a partial message. | Implement a drain period. Track in-flight message count. Only exit when count reaches 0 or timeout. |
| **Health check hits the database on every call** | If the DB is slow, health checks make it slower. Load balancers hammer `/health` every 5s. | Cache health check results for 10s. Use a lightweight query (`SELECT 1`). |
| **Migration rollback deletes data** | A "rollback" that drops a column destroys production data. | Never drop columns in rollbacks. Instead, mark them deprecated. Use expand-contract migrations. |
| **Secrets leak via `JSON.stringify(config)`** | A debug log that stringifies the config object includes API keys. | Create a `sanitizeConfig()` helper that redacts known secret fields. Use it in all log statements that include config. |
| **Plugin sandboxing is hard** | True isolation requires separate V8 contexts or processes. In-process plugins share memory. | Start with convention-based isolation (plugins only access `runtime.getService()`, not global state). Add process-level isolation later if needed. |

---

## Appendix A — Quick reference for common tasks

```bash
# Full build
bun run build

# Full test
bun run test

# Test a single plugin
bun run test -- --filter=@elizaos/plugin-<name>

# Build a single plugin
cd plugins/plugin-<name> && bun run build

# Run convention check
bun run ensure-plugin-test-conventions:check

# Type-check without emitting
cd packages/typescript && bunx tsc --noEmit
```

## Appendix B — File size hot spots (refactoring targets)

| File | Lines | Action |
|------|-------|--------|
| `packages/typescript/src/runtime.ts` | 5,533 | Extract into 4-5 modules (Phase 2.2) |
| `packages/typescript/src/services/message.ts` | 2,228 | Extract into 3 modules (Phase 2.3) |
| `plugins/plugin-sql/typescript/base.ts` | ~2,000 | Extract store logic (Phase 3.5) |
| `packages/typescript/src/database.ts` | 614 | OK for now |
| `packages/typescript/src/types/runtime.ts` | 556 | OK for now |

## Appendix C — Decision log

| Decision | Rationale | Date |
|----------|-----------|------|
| Use `vitest run --passWithNoTests` for plugins with no tests | Prevents CI failure while allowing gradual test addition | 2026-03-10 |
| Guard `test:rs` with fallback echo | Rust toolchain not available on all CI/dev machines | 2026-03-10 |
| `rust-plugin-starter` test is a no-op echo | Requires WASM build that isn't part of the standard build pipeline | 2026-03-10 |
| Convention script in `scripts/` | Centralized enforcement, runnable in CI | 2026-03-10 |
