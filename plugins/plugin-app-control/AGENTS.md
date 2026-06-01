# @elizaos/plugin-app-control

Gives an Eliza agent the ability to launch, close, list, scaffold, and verify Eliza apps, manage UI views, and customize the homescreen canvas.

## Purpose / role

This plugin registers three actions, one provider, and four services. It exposes those capabilities to any Eliza agent that loads it; it is opt-in (not default-enabled). All runtime communication with the Eliza dashboard happens over loopback HTTP (`/api/apps/*`, `/api/views/*`) discovered via `resolveServerOnlyPort`.

## Plugin surface

### Actions

| Name | File | Description |
|---|---|---|
| `APP` | `src/actions/app.ts` | Unified app control. Sub-modes: `launch`, `relaunch`, `load_from_directory`, `list`, `create`. `create` runs a multi-turn scaffold+coding-agent flow. Owner-gated. |
| `VIEWS` | `src/actions/views.ts` | Manage UI views contributed by plugins. Sub-modes: `list`, `current`, `show`/`open`, `search`, `manager`, `broadcast`, `interact`, `pin`, `window`, `create`, `edit`, `delete`/`remove`. Create/edit/delete are owner-gated; read modes are open. |
| `HOMESCREEN` | `src/actions/homescreen.ts` | Customize the live homescreen canvas. Sub-modes: `edit`, `create` (model-generated scene document), `undo`, `redo`, `reset`, `duplicate`, `delete`, `save`. Broadcasts via `POST /api/views/events/broadcast`. |

### Provider

| Name | File | Description |
|---|---|---|
| `available_apps` | `src/providers/available-apps.ts` | Injects installed apps + running run counts into planner context. Active in `settings` and `automation` contexts only; cache scope is per-turn. |

### Services

| Name | Service type constant | File | Description |
|---|---|---|---|
| `AppRegistryService` | `APP_REGISTRY_SERVICE_TYPE = "app-registry"` | `src/services/app-registry-service.ts` | Persists `load_from_directory` registrations; re-registers them on boot. Also owns app-loads audit log and granted-permissions store under `~/.eliza/` (or `ELIZA_STATE_DIR`). |
| `AppVerificationService` | `"app-verification"` | `src/services/app-verification.ts` | Structured verification pipeline (typecheck / lint / test / build / launch / browser screenshot). Called after `APP create` or `VIEWS create` once the coding agent finishes. |
| `AppWorkerHostService` | `APP_WORKER_HOST_SERVICE_TYPE = "app-worker-host"` | `src/services/app-worker-host-service.ts` | Spawns one `node:worker_threads` Worker per app registered with `isolation: "worker"`. Exposes typed RPC (`invoke(slug, method, params)`). |
| `VerificationRoomBridgeService` | `VERIFICATION_ROOM_BRIDGE_SERVICE_TYPE = "verification-room-bridge"` | `src/services/verification-room-bridge.ts` | Listens to the swarm coordinator broadcast bus; posts verification results back into the originating chat room so the user sees the verdict. |

### Views (registered in Plugin.views)

| ID | Label | Path | Bundle component |
|---|---|---|---|
| `views-manager` | Views | `/views` | `ViewManagerView` (gui) |
| `views-manager` | Views XR | `/views` | `ViewManagerView` (xr) |
| `views-manager` | Views TUI | `/views/tui` | `ViewManagerTuiView` (tui) |

View source lives in `src/views/ViewManagerView.tsx`. Bundled separately by `vite.config.views.ts` into `dist/views/bundle.js`.

## Layout

```
src/
  index.ts                        Plugin entry; exports appControlPlugin
  types.ts                        API response shapes (InstalledAppInfo, AppRunSummary, AppLaunchResult, AppStopResult)
  params.ts                       Option normalisation + verb/noun extraction helpers
  resolve.ts                      App/run name resolution (exact + substring match)
  protected-apps.ts               List of built-in apps that cannot be deleted
  client/
    api.ts                        AppControlClient — loopback HTTP to /api/apps/*
  actions/
    app.ts                        APP action dispatcher; imports sub-handlers below
    app-launch.ts                 launch sub-handler
    app-relaunch.ts               relaunch sub-handler (stop + launch, optional verify)
    app-list.ts                   list sub-handler
    app-load-from-directory.ts    load_from_directory sub-handler
    app-create.ts                 create sub-handler (multi-turn scaffold + coding agent)
    homescreen.ts                 HOMESCREEN action
    homescreen-prompt.ts          Prompt builder + scene-JSON extractor for HOMESCREEN
    views.ts                      VIEWS action dispatcher
    views-client.ts               ViewsClient — loopback HTTP to /api/views/*
    views-list.ts                 list sub-handler
    views-show.ts                 show/open sub-handler
    views-search.ts               search sub-handler
    views-create.ts               create sub-handler (multi-turn)
    views-edit.ts                 edit sub-handler
    views-delete.ts               delete sub-handler + confirmation flow
  providers/
    available-apps.ts             available_apps provider
  services/
    app-registry-service.ts       AppRegistryService
    app-verification.ts           AppVerificationService (typecheck/lint/test/build/browser)
    app-worker-host-service.ts    AppWorkerHostService (worker_threads lifecycle + RPC)
    verification-room-bridge.ts   VerificationRoomBridgeService (chat-loop closer)
    verification-helpers.ts       Shared helpers: screenshot, diagnostics, package-manager detect
    index.ts                      Re-exports AppVerificationService + its public types
  views/
    ViewManagerView.tsx           React view component (compiled to dist/views/bundle.js)
    ViewManagerView.test.ts       Unit tests for the view component
    viewManagerData.ts            Data helpers for the view manager
  workers/
    app-worker-entry.ts           Worker entry point for isolation="worker" apps
```

## Commands

```bash
# Build plugin (ESM + declarations + views bundle)
bun run --cwd plugins/plugin-app-control build

# Watch mode (ESM + declarations; excludes views bundle)
bun run --cwd plugins/plugin-app-control dev

# Run tests
bun run --cwd plugins/plugin-app-control test

# Typecheck
bun run --cwd plugins/plugin-app-control typecheck

# Lint (auto-fix)
bun run --cwd plugins/plugin-app-control lint

# Build views bundle only
bun run --cwd plugins/plugin-app-control build:views
```

## Config / env vars

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ELIZA_REPO_ROOT` | No | `cwd()` | Repo root for scaffolding new apps/plugins. Falls back to `ELIZA_WORKSPACE_DIR`. |
| `ELIZA_WORKSPACE_DIR` | No | `cwd()` | Alternate repo/workspace root. |
| `ELIZA_STATE_DIR` | No | `~/.eliza` | State dir for registry, audit logs, granted-permissions store. |
| `ELIZA_NAMESPACE` | No | `eliza` | Namespace prefix used in state dir paths. |
| `ELIZA_PROTECTED_APPS` | No | (built-in list) | Comma-separated app slugs that cannot be deleted by the agent. |
| `ELIZA_API_AUTH_TOKEN` / `ELIZA_API_TOKEN` | No | — | Auth token forwarded to the dashboard API. |
| `ELIZA_PORT` / `ELIZA_API_PORT` | No | auto-detected | Dashboard API port (discovered via `resolveServerOnlyPort`). |
| `ELIZA_BROWSER_VERIFY_OPTIONAL` | No | — | Set to `1` to make the browser step in `AppVerificationService` non-fatal. |
| `ELIZA_CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` | No | — | Chrome path for `AppVerificationService` browser checks. |
| `ELIZA_BUILD_VARIANT` | No | — | Set to `store` to signal a platform that disallows dynamic code loading. |
| `ELIZA_PLATFORM` | No | — | Set to `ios` or `android` to signal a restricted platform. |

## How to extend

### Add a new APP sub-mode

1. Create `src/actions/app-<mode>.ts` — export a `run<Mode>(ctx)` function returning `ActionResult`.
2. Add the mode string to the `AppMode` union in `src/actions/app.ts`.
3. Add it to the `MODES` array in `src/actions/app.ts`.
4. Wire the intent regex and the `switch` dispatch in `app.ts`.
5. Export the function from `src/index.ts` if callers outside this plugin need it.

### Add a new VIEWS sub-mode

Follow the same pattern in `src/actions/views.ts` and create a `src/actions/views-<mode>.ts` file.

### Add a new service

1. Create `src/services/<name>.ts`; extend `Service` from `@elizaos/core`.
2. Export a `serviceType` string constant.
3. Register the service class in the `services` array in `src/index.ts`.
4. Add a `dispose` call in the plugin's `dispose` hook.

## Conventions / gotchas

- **Loopback HTTP only.** The client (`src/client/api.ts`) and all action helpers call the Eliza dashboard over `http://127.0.0.1:<port>`. Port is auto-detected; never hardcode it.
- **APP action requires owner role.** `hasOwnerAccess` from `@elizaos/core` gates all `APP` writes. `VIEWS` read modes are open; write modes (`create`, `edit`, `delete`) are owner-gated.
- **Multi-turn flows.** `APP create` and `VIEWS create` use `hasPendingIntent` / `hasPendingViewsCreateIntent` to detect follow-up choice replies (`new`, `edit-N`, `cancel`). Both check a pending-task record in the runtime before routing to the create sub-handler.
- **Build has two steps.** `tsup` compiles the main entry and the worker entry. `vite build:views` compiles the React view bundle separately. Both must run for a complete build (`bun run build` handles both via `build:views` post-step).
- **`puppeteer-core` is an optional peer dep.** `AppVerificationService` only loads it when a browser step is requested and the dep is present. Set `ELIZA_BROWSER_VERIFY_OPTIONAL=1` if you want failures there to be non-blocking.
- **`AppWorkerHostService` does not auto-start workers on boot.** Workers are only spawned when explicitly invoked; the Phase 2.5 wiring does that.
- **Restricted platforms.** `isRestrictedPlatform()` in `src/actions/views.ts` returns `true` on iOS/Android store builds. Use it to gate dynamic-plugin creation flows.
