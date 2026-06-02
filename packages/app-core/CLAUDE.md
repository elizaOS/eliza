# @elizaos/app-core

Shared application core for elizaOS agent app shells. Provides the CLI bootstrap, the dashboard HTTP API, the Eliza runtime loader, the static app/plugin/connector registry, auth/secrets/vault services, and per-platform (Node, browser, Capacitor/iOS/Android, Electrobun desktop) bootstrap. Consumed by `@elizaos/agent`, `@elizaos/ui`, `@elizaos/shared`, the `packages/app` shell, and most `plugins/*` app plugins (e.g. `plugin-steward-app`, `plugin-registry`, `plugin-lifeops`).

Repo-wide rules (logger-only, ESM, naming, architecture commandments, git workflow) live in the root [AGENTS.md](../../AGENTS.md) — not restated here.

## Layout

```
src/
  entry.ts                  CLI process bootstrap → dist/entry.js (imported by the generated app launcher; no `bin` field)
  index.ts                  Node/runtime barrel (the `.` export) — re-exports api/runtime/registry/security/services
  browser.ts                Browser-safe re-exports (pulls UI surface from @elizaos/ui)
  ui-compat.ts              Legacy UI-compat shims (`./ui-compat` export)
  cli/                      Commander CLI
    run-main.ts             runCli(): env normalize, dotenv, build + parse program
    program/build-program.ts  buildProgram(): help + preaction hooks + commands
    program/command-registry.ts  registerProgramCommands(): start, setup, doctor, db, configure, config, dashboard, update, auth, benchmark, capability-router, subclis
    program/register.*.ts   one file per command
    profile.ts, argv.ts, doctor/  profile env, arg parsing, doctor checks
  api/                      Dashboard HTTP API (server-side)
    server.ts               startApiServer() — wraps @elizaos/agent's server with app-core routes
    dev-stack.ts            /api/dev/stack discovery payload (ELIZA_DEV_STACK_SCHEMA)
    auth.ts, auth/          route authorization
    auth-bootstrap-routes.ts, auth-session-routes.ts, auth-pairing-routes.ts  first-run + device pairing auth
    response.ts             sendJson / sendJsonError helpers
    secrets-*-routes.ts, server-wallet-trade.ts, *-compat-routes.ts
  runtime/                  Runtime loading + lifecycle
    eliza.ts                Eliza agent loader — boots AgentRuntime, loads plugins, starts API server
    dev-server.ts           Dev orchestration entry + startup timing
    desktop/                Electrobun tray/window React runtimes (AppWindowRenderer, DesktopTrayRuntime, …)
    mode/                   runtime-mode (local vs remote), route-mode-guard, remote-forwarder
    build-character-from-config.ts, channel-plugin-map.ts, autonomy-policy.ts, sandbox-policy.ts
  registry/                 Static app/plugin/connector registry (SoT)
    index.ts                loadRegistry(), getApps/getPlugins/getConnectors/getEntry
    schema.ts               zod schemas (configFieldSchema, entry schemas)
    loader.ts               raw-entry validation + merge
    app-registry.ts         runtime curated-app registration (registerCuratedApp)
    entries/{apps,plugins,connectors}/*.json   the registry data
  config/app-config.ts      AppConfig types + DEFAULT_APP_CONFIG (re-exported from @elizaos/shared)
  first-run/                first-run-config + runtime-target resolution
  security/                 agent-vault-id, platform-secure-store (+ -node), wallet key hydration
  services/                 auth-store, steward-credentials/sidecar, vault-mirror/bootstrap, account-pool, task-host-capabilities, sensitive-requests, …
  platform/                 capacitor-bootstrap, ios-runtime-*, native-plugin-entrypoints, empty-node-module (browser-build alias target), *-browser-stub.ts
  permissions/types.ts, diagnostics/integration-observability.ts, connectors/ (capacitor sqlite/jsc/quickjs)
scripts/                    build/packaging/sms-gateway/voice scripts (namespaced in package.json scripts)
platforms/{android,ios,electrobun}/   native shell projects + Apple Store entitlements
```

## Key exports / surface

- Default `.` import → `src/index.ts`: `startApiServer`, the Eliza runtime loader (`runtime/eliza`), `loadRegistry`/`getApps`/`getPlugins`/`getConnectors`/`getEntry`, `registerCuratedApp`, auth helpers, security stores, vault + steward services.
- Subpath exports (see `package.json` `exports`): `./agent-bridge`, `./api/auth`, `./api/response`, `./api/automation-node-contributors`, `./api/compat-route-shared`, `./api/ios-local-agent-transport`, `./registry`, `./first-run/first-run-config`, `./security/agent-vault-id`, `./security/platform-secure-store`, `./security/platform-secure-store-node`, `./services/vault-mirror`, `./services/steward-credentials`, `./services/steward-sidecar/helpers`, `./services/task-host-capabilities`, `./services/app-updates/update-policy`, `./platform/native-plugin-entrypoints`, `./platform/ios-runtime-backends`, `./platform/empty-node-module`, `./platform/native-library-policy`, `./ui-compat`.
- `src/browser.ts` is the browser-safe surface; it re-exports React/UI from `@elizaos/ui` and the desktop runtimes from `runtime/desktop`.

## Commands

Run from repo root with `--cwd packages/app-core`:

- `bun run --cwd packages/app-core build` — `build:dist` (tsc → flatten → copy assets → rewrite dist ESM imports)
- `bun run --cwd packages/app-core typecheck` — `tsgo --noEmit -p tsconfig.json`
- `bun run --cwd packages/app-core test` — vitest (config `vitest.config.ts`)
- `bun run --cwd packages/app-core test:auth` — auth/auth-bootstrap/auth-store suites, no file parallelism
- `bun run --cwd packages/app-core lint` / `lint:fix` / `format` / `format:fix` — Biome
- `bun run --cwd packages/app-core benchmark:server` — action benchmark harness
- SMS-gateway, flatpak, codesign, and voice scripts are namespaced (`sms-gateway:*`, `build:flatpak*`, `codesign:mas*`, `voice:*`) — see `package.json`.

## Config / env vars

- Ports: `ELIZA_API_PORT`/`ELIZA_PORT`/`ELIZA_UI_PORT` are read via `@elizaos/shared` `resolveDesktopApiPort`/`resolveServerOnlyPort`/`syncResolvedApiPort`. Never hardcode; the orchestrator shifts and syncs them.
- `LOG_LEVEL` / `--debug` / `--verbose` / `--no-color` — set in `entry.ts` before runtime imports; also drives `NODE_LLAMA_CPP_LOG_LEVEL`.
- `DATABASE_URL` → bridged to `POSTGRES_URL` for `plugin-sql` (cloud/sandbox provisioners inject `DATABASE_URL`).
- `ELIZAOS_CLOUD_API_KEY` (dev fallback `ELIZA_DEV_CLOUD_API_KEY` in non-prod).
- `ELIZA_API_PROCESS_SPAWNED_AT_MS` / `ELIZA_PROCESS_SPAWNED_AT_MS` — startup timing (dev-server).
- `/api/dev/stack` response schema tag is the `ELIZA_DEV_STACK_SCHEMA` constant (`"elizaos.dev.stack/v1"`) from `api/dev-stack.ts` — it is a code constant, not an env var. State dir via `@elizaos/core` `resolveStateDir`. Provider key aliases normalized in `run-main.ts` (`Z_AI_API_KEY`→`ZAI_API_KEY`, `KIMI_API_KEY`→`MOONSHOT_API_KEY`).
- **App-route boot knobs** (opt-in dev speedups in `runtime/eliza.ts`; both default to byte-identical boot):
  - `ELIZA_SKIP_APP_ROUTE_PLUGINS` — comma-separated app-route-plugin ids/short-aliases to NOT load (`getSkippedAppRoutePluginIds`). Filters WHICH route plugins register (e.g. `lifeops,steward,training,shopify`). Empty/unset → every loader runs.
  - `ELIZA_DEFER_APP_ROUTES=1` — controls WHETHER the post-ready boot tail (app-route plugins, training hooks, sensitive-request adapters, telegram polling, trigger bridge, connector catalog, voice warmup) blocks the readiness gate (`getDeferAppRoutesEnabled`). When `=1`, `/api/health` flips `ready:true` before the tail finishes, so feature routes may 404 for a brief window after "Agent ready"; unset → the tail is awaited inline as before. Only the literal `"1"` enables it. Composes with `ELIZA_SKIP_APP_ROUTE_PLUGINS` (skip filters which load; defer controls when the tail blocks).

## How to extend

- **Add a CLI command:** create `src/cli/program/register.<name>.ts` exporting `register<Name>Command(program)`, then wire it into `src/cli/program/command-registry.ts`.
- **Add an API route:** add a handler module under `src/api/` and dispatch it from `src/api/server.ts` (or the relevant `*-routes.ts`). Use `sendJson` from `api/response.ts`; authorize via `api/auth.ts`.
- **Add a registry app/plugin/connector:** drop a JSON file in `src/registry/entries/{apps,plugins,connectors}/` conforming to `src/registry/schema.ts`. The build copies `src/registry/entries` into `dist`. For runtime-registered curated apps, call `registerCuratedApp` (`registry/app-registry.ts`).
- **Add a subpath export:** add the `exports` map entry in `package.json` AND export it from the right barrel; the build emits the matching `dist/*.d.ts`/`.js`.

## Conventions / gotchas

- `src/platform/empty-node-module.ts` is a tsconfig-paths alias target for browser builds — it is intentionally NOT re-exported from `index.ts` (re-exporting would shadow the real Node `api/server` / `runtime/eliza` exports with noops). Browser bundlers alias it in; Node imports the originals.
- `index.ts` re-exports `./services/steward-sidecar.ts` with an explicit `.ts` extension to disambiguate from the sibling `steward-sidecar/` directory after `tsc --rewriteRelativeImportExtensions`.
- `registry/index.ts` uses a hoisted `var cacheSlot` (not `let`/`const`) to survive circular-import re-entry on Bun's strict ESM runtime (TDZ-hardening); `resolveEntriesDir()` falls back to `src/registry/entries` when `dist/registry/entries` is absent.
- `entry.ts` builds to `dist/entry.js` and is imported by the generated app launcher (desktop/Electrobun bundling emits a tiny ESM file that `import`s `dist/entry.js`) — there is no `bin` field; do not add one assuming a downstream installer.
- `plugin-local-inference` is imported lazily in `runtime/eliza.ts` to avoid static plugin-boundary violations.
- Peer deps `react`, `react-dom`, `three`; Capacitor mobile bridges are `optionalDependencies` (`@elizaos/capacitor-*`). Node `>=24`.
