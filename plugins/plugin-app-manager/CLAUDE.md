# @elizaos/plugin-app-manager

App lifecycle library for elizaOS: hosted-app discovery, launch, run-state tracking, and the `/api/apps/*` HTTP route surface. Extracted from `@elizaos/agent` in Phase 4G.

## Purpose / role

This package is **not** a `Plugin` object with actions/providers registered on `AgentRuntime`. It is a **library** that `@elizaos/agent` wires into its API server. It exports an `AppManager` service class and a `handleAppsRoutes` route handler. Together they power the apps surface: discovering registry apps, launching them (installing the plugin if needed), tracking active runs with heartbeat-based sweeping, and exposing REST endpoints consumed by the dashboard UI.

## Plugin surface

This package registers **no elizaOS plugin object**. It exports pure TypeScript symbols consumed by the host agent:

| Export | Kind | Description |
|---|---|---|
| `AppManager` | Class (service) | In-memory run registry with persistent JSON store. Manages launch, stop, attach, detach, heartbeat, and stale-run sweeping. |
| `handleAppsRoutes` | Function | HTTP route dispatcher for all `/api/apps/*` endpoints. Returns `Promise<boolean>` — `true` if handled, `false` if not matched. |
| `readAppRunStore` | Function | Read `runs.v2.json` from state dir, normalizing and migrating from v1. |
| `writeAppRunStore` | Function | Atomically write runs to `runs.v2.json`. |
| `resolveAppRunStoreFilePath` | Function | Returns absolute path to `<stateDir>/apps/runs.v2.json`. |
| `resolveLegacyAppRunStoreFilePath` | Function | Returns path to `<stateDir>/apps/runs.v1.json` (migration source). |
| `AppManagerLike` | Interface | Structural contract for `AppManager`; used by `handleAppsRoutes` so tests can substitute a mock. |
| `AppsRouteContext` | Interface | Context object `handleAppsRoutes` expects (request, response, helpers, app manager, plugin manager, favorites store, runtime). |
| `FavoriteAppsStore` | Interface | Read/write interface for persisted favorites; implementation lives in the host. |

## Route surface (`handleAppsRoutes`)

All routes are under `/api/apps/`:

| Method | Path | Description |
|---|---|---|
| GET | `/api/apps` | List available apps from registry (curated catalog). |
| GET | `/api/apps/search?q=&limit=` | Full-text search over available apps. |
| GET | `/api/apps/installed` | List installed apps whose plugins are active. |
| GET | `/api/apps/info/:name` | Full registry info for a named app. |
| GET | `/api/apps/hero/:slug` | Stream app hero image (file or generated SVG). |
| GET | `/api/apps/favorites` | Read favorites list. |
| PUT | `/api/apps/favorites` | Toggle a single app's favorite state. |
| POST | `/api/apps/favorites/replace` | Bulk-replace favorites list. |
| GET | `/api/apps/runs` | List active runs (refreshes session state). |
| GET | `/api/apps/runs/:runId` | Get a single run (force-refreshes session). |
| GET | `/api/apps/runs/:runId/health` | Health facet of a run. |
| POST | `/api/apps/runs/:runId/attach` | Mark viewer as attached. |
| POST | `/api/apps/runs/:runId/detach` | Mark viewer as detached. |
| POST | `/api/apps/runs/:runId/stop` | Stop a run by runId. |
| POST | `/api/apps/runs/:runId/heartbeat` | UI liveness ping; returns 404 if already stopped. |
| POST | `/api/apps/runs/:runId/message` | Proxy a message command into the app's route module. |
| POST | `/api/apps/runs/:runId/control` | Proxy a control command into the app's route module. |
| POST | `/api/apps/overlay-presence` | Record overlay-app heartbeat (no run created). |
| POST | `/api/apps/launch` | Launch an app by name (installs plugin if needed). |
| POST | `/api/apps/install` | Install a plugin by name/version (without launch). |
| POST | `/api/apps/stop` | Stop by app name or runId. |
| POST | `/api/apps/relaunch` | Stop then re-launch (atomic replace of run). |
| GET | `/api/apps/plugins` | List non-app registry plugins. |
| GET | `/api/apps/plugins/search?q=` | Search non-app registry plugins. |
| POST | `/api/apps/refresh` | Force registry refresh. |
| GET | `/api/apps/permissions` | List all app permission views (requires `AppRegistryService`). |
| GET | `/api/apps/permissions/:slug` | Get permission view for one app. |
| PUT | `/api/apps/permissions/:slug` | Set granted namespaces for one app. |
| POST | `/api/apps/load-from-directory` | Register apps from a local directory scan. |
| POST | `/api/apps/create` | Invoke the `APP` runtime action in `create` mode. |

## Layout

```
src/
  index.ts                  Public exports (no Plugin object — just symbols)
  api/
    apps-routes.ts          handleAppsRoutes() + AppsRouteContext + AppManagerLike + FavoriteAppsStore
  services/
    app-manager.ts          AppManager class — launch / stop / runs / sweeper
    app-run-store.ts        readAppRunStore / writeAppRunStore / path helpers
```

## Commands

```bash
bun run --cwd plugins/plugin-app-manager build       # compile to dist/
bun run --cwd plugins/plugin-app-manager dev         # same as build (no watch)
bun run --cwd plugins/plugin-app-manager typecheck   # tsgo --noEmit
bun run --cwd plugins/plugin-app-manager test        # vitest run --config vitest.config.ts
bun run --cwd plugins/plugin-app-manager clean       # rm -rf dist
```

## Config / env vars

| Variable | Required | Description |
|---|---|---|
| `ELIZA_APPS_REGISTRY_REFRESH_TIMEOUT_MS` | No | Override the 5 s timeout for registry refresh during `listInstalled`. Min 250 ms. |
| `ELIZA_ENABLE_LEGACY_APPS_WORKSPACE_DISCOVERY` | No | Set to `1`/`true` to also scan `apps/app-<slug>` dirs when resolving hero images (disabled by default). |

The state-dir path used by `readAppRunStore` / `writeAppRunStore` comes from `@elizaos/agent/config/paths#resolveStateDir`. Override it by passing the `stateDir` option to `new AppManager({ stateDir })`.

## How to extend

### Add a new REST endpoint

1. Open `src/api/apps-routes.ts`.
2. Add a new branch inside `handleAppsRoutes` matching on `method` and `pathname`.
3. Import any new Zod request schema from `@elizaos/shared` (keep the wire contract in shared, not here).
4. Add the new route to the route table above.

### Add a new AppManager method

1. Open `src/services/app-manager.ts`.
2. Add the method to the `AppManager` class.
3. Add the corresponding signature to `AppManagerLike` in `src/api/apps-routes.ts` so `handleAppsRoutes` can call it without importing `AppManager` directly.

### Add a new store field to run summaries

`AppRunSummary` is defined in `@elizaos/shared`. After updating the shared type, bump `APP_RUN_STORE_VERSION` in `src/services/app-run-store.ts` and update the `normalizeRun` function to read/migrate the new field.

## Conventions / gotchas

- **No Plugin object exported.** This package does not call `AgentRuntime.registerPlugin`. The host (`@elizaos/agent`) imports `AppManager` and `handleAppsRoutes` directly and wires them into its HTTP server.
- **AppManager is not a singleton.** The host constructs one instance and passes it through `AppsRouteContext`. Tests create their own instances with custom `stateDir` / `heartbeatTimeoutMs` / `heartbeatSweepIntervalMs` options.
- **Stale-run sweeper uses `unref()`.** Call `appManager.startStaleRunSweeper(getRuntime)` after construction; call `appManager.stopStaleRunSweeper()` on shutdown. The interval is `unref()`-ed so it does not keep the process alive.
- **Heartbeat is UI-driven.** The dashboard pings `POST /api/apps/runs/:runId/heartbeat` while `GameView` is mounted. When the tab closes, heartbeats stop and the sweeper reaps the run via the same `stopRun` hook as the explicit Stop button.
- **Template variable substitution.** App launch URLs and viewer URLs may contain `{KEY}` placeholders (e.g. `{BOT_NAME}`, `{RS_SDK_SERVER_URL}`). Only keys in `SAFE_APP_TEMPLATE_ENV_KEYS` are substituted. Unknown keys are preserved as-is for catalog display and stripped for launch.
- **URL safety.** `normalizeSafeAppUrl` rejects non-`http:`/`https:` protocols and protocol-relative `//` forms. Any launch or viewer URL that fails this check throws and aborts launch.
- **Run persistence.** Runs are written atomically to `<stateDir>/apps/runs.v2.json` via `writeJsonAtomicSync` after every mutation. On startup `AppManager` reads and normalizes existing runs (migrating from `runs.v1.json` if present).
- **Agents-list guard.** App launch must not replace the user's active character config. If `agents.list` in `eliza.config.json` changes during launch, it is restored via `shouldRestoreAgentsListAfterAppLaunch` (imported from `@elizaos/agent`).
- **Dependencies.** Declared dependencies are `@elizaos/core`, `@elizaos/plugin-registry`, and `@elizaos/shared`. The source also imports from `@elizaos/agent` subpaths (config, services, registry client) at runtime — `@elizaos/agent` is not listed in `package.json` but is provided by the host at runtime. Keep that boundary in mind if reorganizing.

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

**Capture & manually review for this package — CLI / tooling:**
- The real command/flow invocation transcript (args in, stdout/stderr, exit code) and the artifacts it generated (files, scaffolds, manifests, screenshots/recordings).
- Failure paths: bad args, missing deps, partial state, permission/network errors.
- A recording/log of the actual run end to end — not a unit test of one helper.
- Any model interaction captured as a live trajectory and reviewed.
<!-- END: evidence-and-e2e-mandate -->
