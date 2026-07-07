# @elizaos/app-core

Shared application core for elizaOS agent app shells. Provides the CLI bootstrap, the dashboard HTTP API, the Eliza runtime loader, the static app/plugin/connector registry, auth/secrets/vault services, and per-platform (Node, browser, Capacitor/iOS/Android, Electrobun desktop) bootstrap. Consumed by `@elizaos/agent`, `@elizaos/ui`, `@elizaos/shared`, the `packages/app` shell, and most `plugins/*` app plugins (e.g. `plugin-registry`, `plugin-lifeops`).

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
  dispatch/                 Connector/channel dispatch layer
    index.ts                barrel
    channel-registry.ts     channel registry
    connector-registry.ts   connector registry
    approval-queue.ts       approval queue for dispatched actions
  runtime/                  Runtime loading + lifecycle
    eliza.ts                Eliza agent loader — boots AgentRuntime, loads plugins, starts API server
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
scripts/                    build/packaging/sms-gateway/voice scripts (namespaced in package.json scripts)
platforms/{android,ios,electrobun}/   native shell projects + Apple Store entitlements
```

## Key exports / surface

- Default `.` import → `src/index.ts`: `startApiServer`, the Eliza runtime loader (`runtime/eliza`), `loadRegistry`/`getApps`/`getPlugins`/`getConnectors`/`getEntry`, `registerCuratedApp`, auth helpers, security stores, vault + steward services.
- Subpath exports (see `package.json` `exports`): `./entry`, `./agent-bridge`, `./api/auth`, `./api/response`, `./api/automation-node-contributors`, `./api/compat-route-shared`, `./api/cloud-pair-route`, `./api/ios-local-agent-transport`, `./registry`, `./first-run/first-run-config`, `./security/agent-vault-id`, `./security/platform-secure-store`, `./security/platform-secure-store-node`, `./services/vault-mirror`, `./services/steward-credentials`, `./services/steward-sidecar/helpers`, `./services/task-host-capabilities`, `./services/app-updates/update-policy`, `./platform/native-plugin-entrypoints`, `./platform/ios-runtime-backends`, `./platform/empty-node-module`, `./platform/native-library-policy`, `./ui-compat`.
- `src/browser.ts` is the browser-safe surface; it re-exports React/UI from `@elizaos/ui` and the desktop runtimes from `runtime/desktop`.

## Commands

Run from repo root with `--cwd packages/app-core`:

- `bun run --cwd packages/app-core build` — `build:dist` (tsc → flatten → copy assets → rewrite dist ESM imports)
- `bun run --cwd packages/app-core typecheck` — `tsgo --noEmit -p tsconfig.json`
- `bun run --cwd packages/app-core test` — vitest (config `vitest.config.ts`)
- `bun run --cwd packages/app-core test:auth` — auth/auth-bootstrap/auth-store suites, no file parallelism
- `bun run --cwd packages/app-core lint` / `lint:check` / `format` / `format:check` — Biome
- `bun run --cwd packages/app-core benchmark:server` — action benchmark harness
- SMS-gateway, flatpak, codesign, and voice scripts are namespaced (`sms-gateway:*`, `build:flatpak*`, `codesign:mas*`, `voice:*`) — see `package.json`.

## Config / env vars

- Ports: `ELIZA_API_PORT`/`ELIZA_PORT`/`ELIZA_UI_PORT` are read via `@elizaos/shared` `resolveDesktopApiPort`/`resolveServerOnlyPort`/`syncResolvedApiPort`. Never hardcode; the orchestrator shifts and syncs them.
- `LOG_LEVEL` / `--debug` / `--verbose` / `--no-color` — set in `entry.ts` before runtime imports; also drives `NODE_LLAMA_CPP_LOG_LEVEL`.
- `DATABASE_URL` → bridged to `POSTGRES_URL` for `plugin-sql` (cloud/sandbox provisioners inject `DATABASE_URL`).
- `ELIZAOS_CLOUD_API_KEY` (dev fallback `ELIZA_DEV_CLOUD_API_KEY` in non-prod).
- `ELIZA_API_PROCESS_SPAWNED_AT_MS` / `ELIZA_PROCESS_SPAWNED_AT_MS` — startup timing (dev-server).
- `/api/dev/stack` response schema tag is the `ELIZA_DEV_STACK_SCHEMA` constant (`"elizaos.dev.stack/v1"`) from `api/dev-stack.ts` — it is a code constant, not an env var. State dir via `@elizaos/core` `resolveStateDir`. Provider key aliases normalized in `run-main.ts` (`Z_AI_API_KEY`→`ZAI_API_KEY`, `KIMI_API_KEY`→`MOONSHOT_API_KEY`).
- **App-route boot knobs** (in `runtime/eliza.ts`):
  - `ELIZA_SKIP_APP_ROUTE_PLUGINS` — comma-separated app-route-plugin ids/short-aliases to NOT load (`getSkippedAppRoutePluginIds`). Filters WHICH route plugins register (e.g. `lifeops,steward,training,shopify`). Empty/unset → every loader runs.
  - `ELIZA_DEFER_APP_ROUTES` — controls WHETHER the post-ready boot tail (app-route plugins, training hooks, sensitive-request adapters, telegram polling, trigger bridge, connector catalog, voice warmup) blocks the readiness gate (`getDeferAppRoutesEnabled`). **Deferred by default:** `/api/health` flips `ready:true` before the tail finishes, so feature routes may 404 for a sub-second-to-few-second window after "Agent ready" — poll `/api/health` `deferredBoot.settled` (phase `app-route-tail`) before hitting them instead of sleeping. Set `ELIZA_DEFER_APP_ROUTES=0` (or `false`/`no`/`off`) to await the tail inline before ready (the pre-deferral boot shape, slower time-to-ready). Composes with `ELIZA_SKIP_APP_ROUTE_PLUGINS` (skip filters which load; defer controls when the tail blocks).

## How to extend

- **Add a CLI command:** create `src/cli/program/register.<name>.ts` exporting `register<Name>Command(program)`, then wire it into `src/cli/program/command-registry.ts`.
- **Add an API route:** add a handler module under `src/api/` and dispatch it from `src/api/server.ts` (or the relevant `*-routes.ts`). Use `sendJson` from `api/response.ts`; authorize via `api/auth.ts`.
- **Add a registry app/plugin/connector:** the curated registry moved to `@elizaos/registry/first-party`. Drop a JSON file in `packages/registry/src/first-party/entries/{apps,plugins,connectors}/` conforming to `packages/registry/src/first-party/schema.ts`, or have the plugin self-register at runtime via `registerRegistryEntry()`. For curated-app name matching, call `registerCuratedApp`. `@elizaos/app-core/registry` re-exports all of these for back-compat.
- **Add a subpath export:** add the `exports` map entry in `package.json` AND export it from the right barrel; the build emits the matching `dist/*.d.ts`/`.js`.

## Conventions / gotchas

- `src/platform/empty-node-module.ts` is a tsconfig-paths alias target for browser builds — it is intentionally NOT re-exported from `index.ts` (re-exporting would shadow the real Node `api/server` / `runtime/eliza` exports with noops). Browser bundlers alias it in; Node imports the originals.
- `index.ts` re-exports `./services/steward-sidecar.ts` with an explicit `.ts` extension to disambiguate from the sibling `steward-sidecar/` directory after `tsc --rewriteRelativeImportExtensions`.
- The registry's `var cacheSlot` TDZ-hardening + `resolveEntriesDir()` now live in `@elizaos/registry/first-party` (`packages/registry/src/first-party/index.ts`); `packages/app-core/src/registry/index.ts` is a one-line re-export shim.
- `entry.ts` builds to `dist/entry.js` and is imported by the generated app launcher (desktop/Electrobun bundling emits a tiny ESM file that `import`s `dist/entry.js`) — there is no `bin` field; do not add one assuming a downstream installer.
- `plugin-local-inference` is imported lazily in `runtime/eliza.ts` to avoid static plugin-boundary violations.
- Peer deps `react`, `react-dom`, `three`; Capacitor mobile bridges are `optionalDependencies` (`@elizaos/capacitor-*`). Node `>=24`.
- **iOS local-agent watchdog parity** (`platforms/ios/App/App/AgentWatchdog.swift`, wired from `AppDelegate`): the iOS equivalent of Android's `ElizaAgentService` watchdog (issue #10197). The iOS agent is in-process (the `ElizaBunRuntime` Capacitor plugin, no TCP port), so the watchdog polls liveness through the Capacitor bridge (`ElizaBunRuntime.getStatus().ready`) gated on `localStorage["eliza:mobile-runtime-mode"]` (dormant/no-op only in pure `cloud` mode; `local`, `cloud-hybrid`, and `tunnel-to-mobile` own a phone-side agent), accumulates 3 strikes like Android's `HEALTH_FAIL_STRIKES`, and on a confirmed crash emits a bounded restart *request* (`AgentWatchdog.restartRequestedNotification` + a `window` `eliza:local-agent-restart-requested` event, max 5 attempts/exponential backoff) for the renderer's existing `ElizaBunRuntime.start(...)` to honor — it never invents a second restart mechanism. To auto-recover end-to-end the renderer must honor that restart-request signal.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
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
