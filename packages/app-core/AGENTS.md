# @elizaos/app-core

Shared application host for Eliza app shells. It layers CLI bootstrap, dashboard
APIs, runtime loading, registry compatibility, auth/secrets/vault services, and
Node, browser, Capacitor, iOS, Android, and Electrobun startup around
`@elizaos/agent`. It is consumed by `packages/app`, generated app launchers,
platform packages, and app-facing plugins such as `plugin-registry` and
`plugin-personal-assistant`.

Repository-wide rules and evidence requirements are inherited from the root
[`CLAUDE.md`](../../CLAUDE.md).

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
  dispatch/                 Connector/channel dispatch layer
    index.ts                barrel
    channel-registry.ts     channel registry
    connector-registry.ts   connector registry
    approval-queue.ts       approval queue for dispatched actions
  runtime/                  Runtime loading + lifecycle
    eliza.ts                Public startup composition around @elizaos/agent
    startup/                Runtime repair, contributors, warmup, recovery, and server-only lifecycle
    dev-server.ts           Dev orchestration entry + startup timing
    desktop/                Electrobun tray/window React runtimes (AppWindowRenderer, DesktopTrayRuntime, …)
    build-character-from-config.ts, channel-plugin-map.ts, autonomy-policy.ts, sandbox-policy.ts
  registry/index.ts         Back-compat shim: re-exports `@elizaos/registry/first-party`.
                            The curated app/plugin/connector registry (schema,
                            loader, entries, registerCuratedApp, registerRegistryEntry)
                            now lives in `packages/registry/src/first-party/`.
  config/app-config.ts      AppConfig types + DEFAULT_APP_CONFIG (re-exported from @elizaos/shared)
  first-run/                first-run-config + runtime-target resolution
  security/                 agent-vault-id, platform-secure-store (+ -node), wallet key hydration
  services/                 auth-store, steward-credentials/sidecar, vault-mirror/bootstrap, account-pool, task-host-capabilities, sensitive-requests, …
  platform/                 ios-runtime-*, native-plugin-entrypoints, empty-node-module (browser-build alias target), *-browser-stub.ts
  permissions/types.ts, diagnostics/integration-observability.ts, connectors/ (capacitor sqlite/jsc/quickjs)
scripts/                    build/packaging/voice scripts (namespaced in package.json scripts)
platforms/{android,ios,electrobun}/   native shell projects + Apple Store entitlements
```

## Key exports / surface

- Default `.` import → `src/index.ts`: `startApiServer`, the Eliza runtime loader (`runtime/eliza`), `loadRegistry`/`getApps`/`getPlugins`/`getConnectors`/`getEntry`, `registerCuratedApp`, auth helpers, security stores, vault + steward services.
- Subpath exports (see `package.json` `exports`): `./entry`, `./agent-bridge`, `./api/auth`, `./api/response`, `./api/automation-node-contributors`, `./api/compat-route-shared`, `./api/cloud-pair-route`, `./api/ios-local-agent-transport`, `./registry`, `./first-run/first-run-config`, `./security/agent-vault-id`, `./security/platform-secure-store`, `./security/platform-secure-store-node`, `./services/vault-mirror`, `./services/steward-credentials`, `./services/steward-sidecar/helpers`, `./services/task-host-capabilities`, `./services/app-updates/update-policy`, `./platform/native-plugin-entrypoints`, `./platform/ios-runtime-backends`, `./platform/empty-node-module`, `./platform/native-library-policy`, `./ui-compat`.
- `src/browser.ts` is the browser-safe surface; it re-exports React/UI from `@elizaos/ui` and the desktop runtimes from `runtime/desktop`.

## Commands

Run from repo root with `--cwd packages/app-core`:

- `bun run --cwd packages/app-core build` — `build:dist` (tsc → flatten → copy assets → rewrite dist ESM imports)
- `bun run --cwd packages/app-core typecheck` — `tsc --noEmit -p tsconfig.json`
- `bun run --cwd packages/app-core test` — vitest (config `vitest.config.ts`)
- `bun run --cwd packages/app-core test:auth` — auth/auth-bootstrap/auth-store suites, no file parallelism
- `bun run --cwd packages/app-core lint` / `lint:check` / `format` / `format:check` — Biome
- Real local-provisioning checks use `test:local-provisioning`,
  `test:local-chat`, `test:local-reset`, and `test:app-real-e2e`.
- Flatpak, code-signing, fused-inference, and voice scripts are
  namespaced in `package.json`; inspect the live manifest before running one.

## Config / env vars

- Ports: `ELIZA_API_PORT`/`ELIZA_PORT`/`ELIZA_UI_PORT` are read via `@elizaos/shared` `resolveDesktopApiPort`/`resolveServerOnlyPort`/`syncResolvedApiPort`. Never hardcode; the orchestrator shifts and syncs them.
- `LOG_LEVEL` / `--debug` / `--verbose` / `--no-color` — set in `entry.ts` before runtime imports; also drives `NODE_LLAMA_CPP_LOG_LEVEL`.
- `DATABASE_URL` → bridged to `POSTGRES_URL` for `plugin-sql` (cloud/sandbox provisioners inject `DATABASE_URL`).
- `ELIZAOS_CLOUD_API_KEY` (dev fallback `ELIZA_DEV_CLOUD_API_KEY` in non-prod).
- `ELIZA_API_PROCESS_SPAWNED_AT_MS` / `ELIZA_PROCESS_SPAWNED_AT_MS` — startup timing (dev-server).
- `/api/dev/stack` response schema tag is the `ELIZA_DEV_STACK_SCHEMA` constant (`"elizaos.dev.stack/v1"`) from `api/dev-stack.ts` — it is a code constant, not an env var. State dir via `@elizaos/core` `resolveStateDir`. Provider key aliases normalized in `run-main.ts` (`Z_AI_API_KEY`→`ZAI_API_KEY`, `KIMI_API_KEY`→`MOONSHOT_API_KEY`).
- **App-route boot knobs** (owned by `runtime/startup/app-contributors.ts`):
  - `ELIZA_SKIP_APP_ROUTE_PLUGINS` — comma-separated app-route-plugin ids/short-aliases to NOT load (`getSkippedAppRoutePluginIds`). Filters WHICH route plugins register (e.g. `lifeops,steward,training,shopify`). Empty/unset → every loader runs.
  - `ELIZA_DEFER_APP_ROUTES` — controls WHETHER the post-ready boot tail (app-route plugins, training hooks, sensitive-request adapters, telegram polling, trigger bridge, connector catalog, voice warmup) blocks the readiness gate (`getDeferAppRoutesEnabled`). **Deferred by default:** `/api/health` flips `ready:true` before the tail finishes, so feature routes may 404 for a sub-second-to-few-second window after "Agent ready" — poll `/api/health` `deferredBoot.settled` (phase `app-route-tail`) before hitting them instead of sleeping. Set `ELIZA_DEFER_APP_ROUTES=0` (or `false`/`no`/`off`) to await the tail inline before ready (the pre-deferral boot shape, slower time-to-ready). Composes with `ELIZA_SKIP_APP_ROUTE_PLUGINS` (skip filters which load; defer controls when the tail blocks).

## How to extend

- **Add a CLI command:** create `src/cli/program/register.<name>.ts` exporting `register<Name>Command(program)`, then wire it into `src/cli/program/command-registry.ts`.
- **Add an API route:** add a handler module under `src/api/` and dispatch it from `src/api/server.ts` (or the relevant `*-routes.ts`). Use `sendJson` from `api/response.ts`; authorize via `api/auth.ts`.
- **Add a registry app/plugin/connector:** curated data lives under
  `packages/registry/src/first-party/curated/{apps,plugins,connectors}/` and
  conforms to `packages/registry/src/first-party/schema.ts`. Regenerate the
  derived registry rather than editing `generated.json`. Runtime-owned entries
  may self-register through `registerRegistryEntry()`; curated app aliases use
  `registerCuratedApp`. `@elizaos/app-core/registry` remains a compatibility
  re-export.
- **Add a subpath export:** add the `exports` map entry in `package.json` AND export it from the right barrel; the build emits the matching `dist/*.d.ts`/`.js`.

## Conventions / gotchas

- `src/platform/empty-node-module.ts` is a tsconfig-paths alias target for browser builds — it is intentionally NOT re-exported from `index.ts` (re-exporting would shadow the real Node `api/server` / `runtime/eliza` exports with noops). Browser bundlers alias it in; Node imports the originals.
- `index.ts` re-exports `./services/steward-sidecar.ts` with an explicit `.ts` extension to disambiguate from the sibling `steward-sidecar/` directory after `tsc --rewriteRelativeImportExtensions`.
- The registry's `var cacheSlot` TDZ-hardening + `resolveEntriesDir()` now live in `@elizaos/registry/first-party` (`packages/registry/src/first-party/index.ts`); `packages/app-core/src/registry/index.ts` is a one-line re-export shim.
- `entry.ts` builds to `dist/entry.js` and is imported by the generated app launcher (desktop/Electrobun bundling emits a tiny ESM file that `import`s `dist/entry.js`) — there is no `bin` field; do not add one assuming a downstream installer.
- `plugin-local-inference` routes are imported lazily by the API compatibility boundary; startup hooks resolve through `runtime/startup/app-contributors.ts` to avoid static plugin coupling.
- Peer deps `react`, `react-dom`, `three`; Capacitor mobile bridges are `optionalDependencies` (`@elizaos/capacitor-*`). Node `>=24`.
- **iOS local-agent watchdog parity** (`platforms/ios/App/App/AgentWatchdog.swift`, wired from `AppDelegate`): the iOS equivalent of Android's `ElizaAgentService` watchdog (issue #10197). The iOS agent is in-process (the `ElizaBunRuntime` Capacitor plugin, no TCP port), so the watchdog polls liveness through the Capacitor bridge (`ElizaBunRuntime.getStatus().ready`) gated on `localStorage["eliza:mobile-runtime-mode"]` (dormant/no-op only in pure `cloud` mode; `local`, `cloud-hybrid`, and `tunnel-to-mobile` own a phone-side agent), accumulates 3 strikes like Android's `HEALTH_FAIL_STRIKES`, and on a confirmed crash emits a bounded restart *request* (`AgentWatchdog.restartRequestedNotification` + a `window` `eliza:local-agent-restart-requested` event, max 5 attempts/exponential backoff) for the renderer's existing `ElizaBunRuntime.start(...)` to honor — it never invents a second restart mechanism. To auto-recover end-to-end the renderer must honor that restart-request signal.

## Package completion evidence

Follow the repository-wide definition of done in the root guide. For app-core
changes, additionally capture and inspect:

- the real host startup and affected API/CLI path with structured logs;
- live-model trajectories and resulting state for runtime-loading changes;
- browser, desktop, iOS, or Android artifacts on every affected platform; and
- the actual installed revision before collecting screenshots or recordings.
