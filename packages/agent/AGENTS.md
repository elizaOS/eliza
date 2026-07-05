# @elizaos/agent

Standalone elizaOS agent + HTTP backend server. Wraps `@elizaos/core`'s `AgentRuntime`, resolves and boots the bundled `@elizaos/plugin-*` set, and serves a local dashboard/control API. This is the package the `eliza-autonomous` binary runs.

## Role

- Consumed by the desktop/mobile shells and CLI as the agent process and backend server. Many subpath exports (`@elizaos/agent/api`, `/runtime`, `/services/*`, `/config/*`, `/security/*`, `/auth/*`) are imported by sibling `@elizaos/plugin-*` packages and the app shell.
- Owns runtime boot, plugin resolution/lifecycle, the HTTP API + route dispatch, character/config loading, trajectory persistence, triggers/scheduling, permission brokering, and the TEE (dstack) boot/key-release path.

Repo-wide conventions (logger-only, ESM, naming, architecture rules, git workflow) live in the root [AGENTS.md](../../AGENTS.md) — not repeated here.

## Layout

```
src/
  bin.ts                  #!/usr/bin/env node entry → cli/index.ts; mobile (android/ios) bootstrap shims
  index.ts                Public barrel — re-exports api/runtime/services/config/auth/security/triggers
  version-resolver.ts     Resolves package version (__ELIZA_VERSION__ / package.json / build-info.json)
  cli/
    index.ts              runAutonomousCli() — command dispatch: serve|start|tui|tui-smoke|runtime|ios-bridge|android-bridge|benchmark
    benchmark.ts          Headless benchmark runner (runBenchmark)
  runtime/
    eliza.ts              startEliza() / bootElizaRuntime() / startInCloudMode() — core boot orchestration
    eliza-plugin.ts       createElizaPlugin() — the "eliza" Plugin (workspace/session providers, lifecycle actions, services)
    core-plugins.ts       CORE_PLUGINS / BLOCKING_ / DEFERRED_ / OPTIONAL_ / MOBILE_ / ELIZAOS_ANDROID_ plugin name lists
    plugin-resolver.ts    resolvePlugins() — resolve plugin names → modules; getLastFailedPluginNames()
    plugin-collector.ts   collectPluginNames(), CHANNEL/OPTIONAL/PROVIDER_PLUGIN_MAP
    plugin-lifecycle.ts   Plugin install/eject/reinject lifecycle
    plugin-role-gating.ts Role-based plugin access gating
    roles.ts / roles/     Role definitions and role-resolution helpers
    agent-wallets.ts      Agent wallet bootstrap and TEE-gated wallet logic
    model-resolution.ts   Model name resolution helpers
    prompt-optimization.ts / prompt-compaction.ts  Prompt optimization and compaction strategies
    tool-call-cache/ tool-call-cache-wrapper.ts  Tool-call result caching layer
    first-time-setup.ts   First-run initialization logic
    load-plugin-from-directory.ts / load-plugin-from-vfs.ts  Plugin loading from local dirs and VFS
    sandbox-registry.ts / sandbox-character.ts  Sandbox plugin registry and character isolation
    restart.ts            Runtime restart helpers
    release-plugin-policy.ts  Plugin release-channel gating policy
    boot-telemetry.ts / boot-timer.ts  Boot timing and telemetry
    view-action-affinity.ts  View↔action routing affinity
    web-search-tools.ts / vault-profile-resolver.ts  Miscellaneous runtime helpers
    trajectory-*.ts       Trajectory persistence / query / internals
    conversation-compactor*.ts  Conversation summarization/compaction
    operations/           vault-bridge.ts (Vault-backed config env resolution), classifier.ts,
                          cold-strategy.ts, manager.ts, health.ts, health-checks.ts,
                          reload-hot.ts, repository.ts, types.ts
  api/
    server.ts             startApiServer() — HTTP stack, auth, CORS, WS upgrade, route dispatch
    runtime-mode/         mode resolution (local/local-only/cloud/remote), route-visibility gate + remote-mode forwarder run pre-dispatch by every host
    dispatch-route.ts     dispatchRoute() — maps requests to handlers
    *-routes.ts           ~38 route modules (agent admin/lifecycle/status, auth, character, memory, models, permissions, registry, etc.)
    server-helpers*.ts    Auth/conversation/wallet helpers (trusted-local checks, tokens)
    server-types.ts       Conversation/server/plugin transport types
    index.ts              api barrel (@elizaos/agent/api)
  config/
    character-schema.ts   CharacterSchema (zod)
    config.ts             loadElizaConfig() / saveElizaConfig()
    plugin-auto-enable.ts Plugin auto-enable resolution
    paths.ts              resolveUserPath() and state/path helpers
    env-vars.ts, schema.ts, model-metadata.ts, owner-contacts.ts
  services/               Business-logic services (capability-broker, permissions-registry, config-plugin-manager, plugin-installer/-compiler, relationships-graph, agent-export, shell-execution-router, tee-*, dstack-tee-provider, cove-quote)
  actions/                Eliza actions registered by createElizaPlugin (terminal, trigger, contact, settings, plugin, logs, runtime, database, memory, compact-conversation)
  providers/              Providers for createElizaPlugin (workspace, admin-trust/-panel, session, rolodex, recent/relevant-conversations, pending-permissions, escalation-trigger, page-scoped-context, ...)
  triggers/               runtime.ts (registerTriggerTaskWorker), scheduling.ts, types.ts
  auth/                   Credential storage + OAuth/Anthropic/OpenAI-Codex flows (account-storage, oauth-flow, refresh-mutex)
  security/               access.ts, audit-log.ts, network-policy.ts, mcp-server-config.ts (validateMcpServerConfig)
  tui/                    agent-terminal-tui.ts, slash-commands.ts, tui-enabled.ts — terminal UI implementation
  awareness/              Re-exports AwarenessRegistry from @elizaos/shared
  hooks/                  loadHooks() / triggerHook() — workspace hook discovery + dispatch
  contracts/awareness.ts  Local-only awareness contract types
  diagnostics/            integration-observability.ts
  shared/                 workspace-resolution.ts (resolveDefaultAgentWorkspaceDir)
scripts/                  build-mobile-bundle.mjs, live-sandbox-smoke.ts, tee-*-smoke.ts, validate-tee-*.mjs
docs/                     capability-router-remote-plugins.md, e2b-capability-routing.md, tee-agent-implementation-plan.md
```

## Key exports / surface

- **Binary:** `eliza-autonomous` → `src/bin.ts` → `runAutonomousCli()`. Commands: `serve`/`start`, `runtime`, `tui`, `tui-smoke`, `ios-bridge`, `android-bridge`, `benchmark`.
- **Boot:** `startEliza()`, `bootElizaRuntime()`, `startInCloudMode()` (`runtime/eliza.ts`); `createElizaPlugin()` (`runtime/eliza-plugin.ts`) — the `Plugin` named `"eliza"` registering services (`AgentEventService`, `ElizaCharacterPersistenceService`, `AgentMediaGenerationService`, `PermissionRegistry`), workspace/session/rolodex providers, and the terminal/trigger/contact/settings/plugin/logs/runtime/database/memory/compact actions.
- **HTTP:** `startApiServer()`, `dispatchRoute()`, route handlers (`@elizaos/agent/api`).
- **Plugin sets:** `CORE_PLUGINS`, `BLOCKING_CORE_PLUGINS`, `DEFERRED_CORE_PLUGINS`, `OPTIONAL_CORE_PLUGINS`, `MOBILE_CORE_PLUGINS` (`runtime/core-plugins.ts`); `resolvePlugins()`, `collectPluginNames()`.
- **Config:** `loadElizaConfig`/`saveElizaConfig`, `CharacterSchema`, `resolveUserPath`, `resolveDefaultAgentWorkspaceDir`.
- **Services (named subpaths):** `getCapabilityBroker`/`CapabilityBroker`, `PermissionRegistry`, `runShell` (`services/shell-execution-router.ts`), `resolveRelationshipsGraphService`, TEE helpers (`tee-*`, `dstack-tee-provider`, `cove-quote`).
- Cloud route handlers (`handleCloudRoute`, `handleCloudBillingRoute`, `validateCloudBaseUrl`) are lazy re-exports that dynamically import `@elizaos/plugin-elizacloud`.

## Commands

Run from repo root targeting this package:

```bash
bun run --cwd packages/agent start            # bun run src/bin.ts (defaults to `serve`)
bun run --cwd packages/agent dev              # bun --hot src/bin.ts
bun run --cwd packages/agent typecheck        # tsgo --noEmit -p tsconfig.json
bun run --cwd packages/agent test             # vitest run --config vitest.config.ts
bun run --cwd packages/agent lint             # biome check --write (curated src subdirs)
bun run --cwd packages/agent lint:check       # biome check read-only
bun run --cwd packages/agent format           # biome format --write
bun run --cwd packages/agent format:check     # biome format read-only
bun run --cwd packages/agent build            # build:dist (tsc --noCheck → prepare-package-dist → rewrite imports)
bun run --cwd packages/agent build:mobile     # bun scripts/build-mobile-bundle.mjs
bun run --cwd packages/agent build:ios-bun    # mobile bundle, --target=ios
bun run --cwd packages/agent test:remote-capabilities
bun run --cwd packages/agent test:sandbox-live
```

`build:docker-dist`, `build:ios-jsc`, `clean`, `pack:dry-run`, `test:remote-capabilities:{docker,cloud-live,provider-live,source-build}` also exist in `package.json`.

## Config / env vars

State and platform:
- `ELIZA_STATE_DIR` — per-user state root (DB, config, logs). `PGLITE_DATA_DIR` / `POSTGRES_URL` for the SQL store.
- `ELIZA_PLATFORM` (`android`/`ios`/…), `ELIZA_BUILD_VARIANT`, `ELIZA_RUNTIME_MODE`, `ELIZA_MOBILE_LOCAL_AGENT`, `ELIZA_DEVICE_BRIDGE_ENABLED`, `ELIZA_LOCAL_LLAMA`.

Cloud + models:
- `ELIZAOS_CLOUD_ENABLED`, `ELIZAOS_CLOUD_API_KEY`, `ELIZAOS_CLOUD_BASE_URL`, `ELIZA_CLOUD_PROVISIONED`.
- Model overrides: `ELIZAOS_CLOUD_{NANO,SMALL,MEDIUM,LARGE,MEGA}_MODEL`, `ELIZAOS_CLOUD_{PLANNER,ACTION_PLANNER,SHOULD_RESPOND,RESPONSE_HANDLER}_MODEL`.
- Provider keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`.

Capability router (remote plugins — see `docs/capability-router-remote-plugins.md`):
- `ELIZA_CAPABILITY_ROUTER_ENABLED`, `ELIZA_CAPABILITY_ROUTER_URLS`, `ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES`, `ELIZA_CAPABILITY_ROUTER_TRUST_POLICY`, `ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT`.

Wallet/chain: `EVM_PRIVATE_KEY`, `SOLANA_PRIVATE_KEY`, `ELIZA_WALLET_NETWORK`, `{BSC,QUICKNODE_BSC,NODEREAL_BSC}_RPC_URL`. Misc: `GITHUB_TOKEN`, `LOG_LEVEL`, `ELIZA_CONVERSATION_COMPACTOR`.

Stability (memory watchdog — `runtime/memory-watchdog.ts`, #10197): the boot
sampler (`runtime/boot-telemetry.ts`) only *records* RSS; the watchdog *acts* on
it by requesting a clean restart through the existing `requestRestart()` seam
(host exits `RESTART_EXIT_CODE=75`, the `app-core/scripts/run-node.mjs`
supervisor relaunches) — never a silent `process.exit`.
- `ELIZA_MEMORY_WATCHDOG` — `1`/`true` enables it (default **off**).
- `ELIZA_MEMORY_WATCHDOG_RSS_MB` — RSS restart threshold in MB (default `1536`, floor `128`).
- `ELIZA_MEMORY_WATCHDOG_INTERVAL_MS` — sample interval (default `30000`, floor `1000`).
- `ELIZA_MEMORY_WATCHDOG_SUSTAINED` — consecutive over-threshold samples before a restart, to debounce transient spikes (default `3`, floor `1`).

## How to extend

- **Add an Eliza action/provider to the agent plugin:** add the file under `src/actions/` or `src/providers/`, export it through the directory barrel (`actions/index.ts`), then wire it into the `actions`/`providers` arrays in `createElizaPlugin()` (`runtime/eliza-plugin.ts`). Parent actions with subactions are flattened via `promoteSubactionsToActions(...)`.
- **Add an HTTP route:** create `src/api/<name>-routes.ts` exporting a handler, register it in `api/dispatch-route.ts`, and export it from `api/index.ts`. Every route needs a real client caller (root AGENTS.md rule 10).
- **Add/enable a bundled plugin:** add the package name to the appropriate list in `runtime/core-plugins.ts` (`CORE_PLUGINS`, `BLOCKING_`/`DEFERRED_`, `MOBILE_`/`ELIZAOS_ANDROID_`) and add it as a `workspace:*` dependency in `package.json`.
- **Add a service:** put it under `src/services/`, register the class in the `services` array of `createElizaPlugin()`, and export from `services/index.ts`.

## Conventions / gotchas

- `bin.ts` statically imports `node:fs` and pins AOSP/mobile bootstrap symbols onto `globalThis` to defeat tree-shaking in the mobile bundle — do not remove those guards.
- `core-plugins.ts` splits plugins into blocking vs deferred boot phases; slow feature/provider plugins must stay in the deferred set or boot regresses.
- Several barrel re-exports avoid duplicate-symbol (`TS2308`) collisions and lazy-load heavy plugins (wallet, app-manager, elizacloud) — read the inline comments in `index.ts`/`api/index.ts`/`services/index.ts` before adding broad `export *` lines.
- `lint`/`lint:check` only cover a curated subset of `src/` directories (see the script in `package.json`); `format` covers all of `src`.
- TEE work (dstack) is gated behind `services/tee-boot-gate*` and validated by `scripts/validate-tee-*.mjs` + `scripts/tee-*-smoke.ts`; see `docs/tee-agent-implementation-plan.md`.
- **Files / media storage.** Attachment bytes live in one content-addressed store, `api/media-store.ts` (`${STATE_DIR}/media/<sha256>.<ext>`, served pre-auth at `/api/media/<sha256>` with `nosniff` + a download `Content-Disposition` for SVG/active types). `services/file-storage.ts` (`LocalFileStorageService`, fills `ServiceType.REMOTE_FILES`) is the contract the rest of the system resolves via `runtime.getService(ServiceType.REMOTE_FILES)` — `store`/`getUrl`/`list`/`delete`; the authenticated `api/files-routes.ts` (`GET`/`DELETE /api/files`) and the `actions/files.ts` `FILES` agent tool both go through it. `api/media-runtime.ts` rehosts inline `data:` and remote generated-media URLs into the store on the outgoing path (SSRF-guarded) and runs the reference-aware orphan GC (which also counts document `metadata.mediaUrl`). Do NOT add a second file store, a `files` DB table, or a refcount/GC engine — see issue #8876 and the root AGENTS.md anti-pattern clause.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — runtime / framework:**
- A **live-LLM** scenario trajectory for the runtime path you touched — provider → model → action → evaluator — with the raw `<response>` XML and every tool/action call visible and **read**.
- Backend `[ClassName]` logs proving the message loop, task scheduler, or service actually fired end to end.
- The memory/state artifacts produced — rows written, embeddings, room/world/entity records, scheduled-task rows — inspected, not assumed.
- For shared modules: `build:node` vs full `build` so the browser/edge bundles still compile.
<!-- END: evidence-and-e2e-mandate -->
