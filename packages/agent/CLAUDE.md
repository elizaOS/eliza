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
    core-plugins.ts       CORE_PLUGINS / BLOCKING_ / DEFERRED_ / OPTIONAL_ / MOBILE_ / ANDROID_ plugin name lists
    plugin-resolver.ts    resolvePlugins() — resolve plugin names → modules; getLastFailedPluginNames()
    plugin-collector.ts   collectPluginNames(), CHANNEL/OPTIONAL/PROVIDER_PLUGIN_MAP
    plugin-lifecycle.ts   Plugin install/eject/reinject lifecycle
    trajectory-*.ts       Trajectory persistence / query / internals
    conversation-compactor*.ts  Conversation summarization/compaction
    operations/vault-bridge.ts   Vault-backed config env resolution
  api/
    server.ts             startApiServer() — HTTP stack, auth, CORS, WS upgrade, route dispatch
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
  services/               Business-logic services (capability-broker, permissions-registry, plugin-manager/-installer/-compiler, relationships-graph, agent-export, shell-execution-router, tee-*, dstack-tee-provider, cove-quote)
  actions/                Eliza actions registered by createElizaPlugin (terminal, trigger, contact, settings, plugin, logs, runtime, database, memory, compact-conversation)
  providers/              Providers for createElizaPlugin (workspace, admin-trust/-panel, session, rolodex, recent/relevant-conversations, pending-permissions, escalation-trigger, page-scoped-context, ...)
  triggers/               runtime.ts (registerTriggerTaskWorker), scheduling.ts, types.ts
  auth/                   Credential storage + OAuth/Anthropic/OpenAI-Codex flows (account-storage, oauth-flow, refresh-mutex)
  security/               access.ts, audit-log.ts, network-policy.ts, mcp-server-config.ts (validateMcpServerConfig)
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
bun run --cwd packages/agent lint             # biome check (curated src subdirs)
bun run --cwd packages/agent lint:fix
bun run --cwd packages/agent format
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

## How to extend

- **Add an Eliza action/provider to the agent plugin:** add the file under `src/actions/` or `src/providers/`, export it through the directory barrel (`actions/index.ts`), then wire it into the `actions`/`providers` arrays in `createElizaPlugin()` (`runtime/eliza-plugin.ts`). Parent actions with subactions are flattened via `promoteSubactionsToActions(...)`.
- **Add an HTTP route:** create `src/api/<name>-routes.ts` exporting a handler, register it in `api/dispatch-route.ts`, and export it from `api/index.ts`. Every route needs a real client caller (root AGENTS.md rule 10).
- **Add/enable a bundled plugin:** add the package name to the appropriate list in `runtime/core-plugins.ts` (`CORE_PLUGINS`, `BLOCKING_`/`DEFERRED_`, `MOBILE_`/`ANDROID_`) and add it as a `workspace:*` dependency in `package.json`.
- **Add a service:** put it under `src/services/`, register the class in the `services` array of `createElizaPlugin()`, and export from `services/index.ts`.

## Conventions / gotchas

- `bin.ts` statically imports `node:fs` and pins AOSP/mobile bootstrap symbols onto `globalThis` to defeat tree-shaking in the mobile bundle — do not remove those guards.
- `core-plugins.ts` splits plugins into blocking vs deferred boot phases; slow feature/provider plugins must stay in the deferred set or boot regresses.
- Several barrel re-exports avoid duplicate-symbol (`TS2308`) collisions and lazy-load heavy plugins (wallet, app-manager, elizacloud) — read the inline comments in `index.ts`/`api/index.ts`/`services/index.ts` before adding broad `export *` lines.
- `lint`/`lint:fix` only cover a curated subset of `src/` directories (see the script in `package.json`); `format` covers all of `src`.
- TEE work (dstack) is gated behind `services/tee-boot-gate*` and validated by `scripts/validate-tee-*.mjs` + `scripts/tee-*-smoke.ts`; see `docs/tee-agent-implementation-plan.md`.
