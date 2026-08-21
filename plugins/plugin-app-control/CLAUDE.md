# @elizaos/plugin-app-control

Gives an Eliza agent control over app lifecycle, shell views, backgrounds,
models, active agent profiles, and built-in settings.

## Purpose / role

This opt-in plugin registers eight actions, no natural-language routing shortcuts or
automatic navigation evaluators, two providers, and four services. The normal
Eliza model pipeline selects `VIEWS` and supplies its structured parameters.
Dashboard operations use authenticated
loopback HTTP (`/api/apps/*`, `/api/views/*`) discovered through the existing
port resolver.

## Plugin surface

### Actions

| Name | File | Description |
|---|---|---|
| `APP` | `src/actions/app.ts` | Unified app control. Sub-modes: `launch`, `relaunch`, `stop`, `load_from_directory`, `list`, `create`. `stop` uses the canonical name-based `/api/apps/stop` route without uninstalling or relaunching. `create` runs a multi-turn scaffold+coding-agent flow. Owner-gated. |
| `VIEWS` | `src/actions/views.ts` | Manage UI views contributed by plugins. Sub-modes: `list`, `current`, `show`/`open`, `search`, `manager`, `broadcast`, `interact`, `pin`, `window`, `create`, `edit`, `icon`, `rollback`, `delete`/`remove`. `show`/`open` return an internal navigation receipt and explicitly require post-tool evaluation so the model writes the visible reply after the shell handoff. Create/edit/icon/rollback/delete are owner-gated; read modes are open. `rollback` resets a created/edited view-or-plugin workdir to the pre-edit git snapshot taken before the coding agent ran (#8915) and re-registers it via `load-from-directory`. |
| `BACKGROUND` | `src/actions/background.ts` | Change the unified app background from chat. Ops: `set` (color name/hex, a named **programmable GLSL shader** preset — `aurora`/`lava`/`plasma`/`waves`/`nebula` — plus relative uniform tweaks like *slower*/*brighter*/*bigger* (#10694), an uploaded image attachment, or a generated image from a prompt), `undo`, `redo`, `reset`. The action names a preset id + uniform patch only; the GLSL source lives in `@elizaos/ui` (`backgrounds/shader-presets.ts`) where `useBackgroundApplyChannel` resolves id→source, validates it, and `ProgrammableShaderBackground` renders it via three.js with a compile-validate + frame-watchdog + context-loss-recovery + reduced-motion + color-field fallback. Broadcasts a `background:apply` view event via `POST /api/views/events/broadcast`; the renderer applies it to the shared `BackgroundConfig` store. Drives the SAME background as the `/background` view — there is no separate homescreen-scene surface. |
| `SETTINGS` | `src/actions/settings.ts` | Describe, list, and change built-in settings; mutations use the same semantic routes as the UI. Successful list/set results own canonical reply text and declare a single-operation turn complete once the plan queue is drained, avoiding a redundant evaluator model call on native function-calling backends without suppressing multi-tool evaluation. Owner-gated. |
| `MODEL_SWITCH` | `src/actions/model-switch.ts` | Select a configured model target through the canonical settings/runtime boundary. |
| `AGENT_SWITCH` | `src/actions/agent-switch.ts` | Switch the active agent profile through the host-provided agent-switch seam. |
| `CLOSE_VIEW` / `CLOSE_ALL_VIEWS` | `src/actions/views.ts` | Close one shell view or all open views without overloading the broader `VIEWS` dispatcher. |

### Evaluators

| Name | File | Description |
|---|---|---|
| `viewContextEvaluator` | `src/evaluators/view-context.ts` | Legacy test source only; it is not exported, bundled, or registered by the first-party plugin. |
| `viewCommandShortcutEvaluator` | `src/evaluators/view-command-shortcut.ts` | Legacy test source only; it is not exported, bundled, or registered because the model owns view-action selection. |
| `createChoiceShortcutEvaluator` | `src/evaluators/create-choice-shortcut.ts` | Routes replies to pending app/view creation choices without another model decision. |
| `viewFollowupRoutingEvaluator` | `src/evaluators/view-followup-routing.ts` | Legacy test source only; it is not exported, bundled, or registered. Focused-view follow-ups stay in Stage 1 and the planner. |

### Shortcuts

| Name | File | Description |
|---|---|---|
| `viewNavigationShortcuts` | `src/shortcuts.ts` | Legacy test source only; it is not exported, bundled, or registered ahead of the model. |

### Providers

| Name | File | Description |
|---|---|---|
| `available_apps` | `src/providers/available-apps.ts` | Injects installed apps + running run counts into planner context. Active in `settings` and `automation` contexts only; cache scope is per-turn. |
| `current_view` | `src/providers/current-view.ts` | Supplies current shell-view context and acknowledgement state for navigation turns. |

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

View source lives in `src/views/ViewManagerView.tsx`. Bundled separately by `vite.config.views.ts` into `dist/views/bundle.js`. The `viewType` contract still accepts future modality entries, but this plugin ships only the GUI declaration today.

## Layout

```
src/
  index.ts                        Plugin entry; exports appControlPlugin
  types.ts                        API response shapes (InstalledAppInfo, AppRunSummary, AppLaunchResult, AppStopResult)
  shortcuts.ts                    Compatibility natural-language shortcut definitions; not registered by the plugin
  params.ts                       Option normalisation + verb/noun extraction helpers
  resolve.ts                      App/run name resolution (exact + substring match)
  protected-apps.ts               List of built-in apps that cannot be deleted
  client/
    api.ts                        AppControlClient — loopback HTTP to /api/apps/*
  actions/
    app.ts                        APP action dispatcher; imports sub-handlers below
    app-launch.ts                 launch sub-handler
    app-relaunch.ts               relaunch sub-handler (stop + launch, optional verify)
    app-stop.ts                   stop sub-handler (canonical name/run route, no relaunch)
    app-list.ts                   list sub-handler
    app-load-from-directory.ts    load_from_directory sub-handler
    app-create.ts                 create sub-handler (multi-turn scaffold + coding agent)
    scaffold-env.ts               shared template/plugins-dir resolution + coding-dispatch preflight for the create flows
    background.ts                 BACKGROUND action (set color/shader-preset/image/generate, tweak, undo, redo, reset)
    settings.ts                   SETTINGS action (list/get/set built-in settings)
    views.ts                      VIEWS action dispatcher
    views-client.ts               ViewsClient — loopback HTTP to /api/views/*
    views-request-auth.ts         Alias-aware Bearer headers for authenticated view loopback requests
    views-list.ts                 list sub-handler
    views-show.ts                 show/open sub-handler
    views-search.ts               search sub-handler
    views-create.ts               create sub-handler (multi-turn)
    views-edit.ts                 edit sub-handler (takes a pre-edit git snapshot)
    views-icon.ts                 icon sub-handler (direct hero-asset regeneration)
    views-rollback.ts             rollback sub-handler: git reset --hard <snapshot> + re-register (#8915)
    views-snapshot.ts             pre-edit git snapshot + rollback helpers; snapshot-record persistence
    views-plugin-source.ts        resolve a view's on-disk plugin source dir
    views-delete.ts               delete sub-handler + confirmation flow
  components/
    ViewManagerSpatialView.tsx    Presentational spatial view-manager component
  evaluators/
    view-context.ts               compatibility contextual routing; not registered by the plugin
    view-command-shortcut.ts      compatibility deterministic routing; not registered by the plugin
    create-choice-shortcut.ts     pending create-choice routing
    view-followup-routing.ts      compatibility mutation-follow-up evaluator; not registered by the plugin
  providers/
    available-apps.ts             available_apps provider
    current-view.ts               current_view provider
  services/
    app-registry-service.ts       AppRegistryService
    app-verification.ts           AppVerificationService (typecheck/lint/test/build/browser)
    app-worker-host-service.ts    AppWorkerHostService (worker_threads lifecycle + RPC)
    verification-room-bridge.ts   VerificationRoomBridgeService (chat-loop closer)
    verification-helpers.ts       Shared helpers: screenshot, diagnostics, package-manager detect
    index.ts                      Re-exports AppVerificationService + its public types
  views/
    ViewManagerView.tsx           React view component; exports ViewManagerView
    ViewManagerView.test.ts       Unit tests for the view component
    viewManagerData.ts            Data helpers for the view manager
    app-control-view-bundle.ts    View bundle registration entry point
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
| `ELIZA_REPO_ROOT` | No | `cwd()` | Repo root for scaffolding new apps/plugins. Falls back to `ELIZA_WORKSPACE_DIR`. Packaged installs without a checkout still scaffold: templates resolve from the installed `elizaos` package and new plugins land in `<stateDir>/plugins` (see `src/actions/scaffold-env.ts`). |
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
- **APP stop shares the UI route.** Name-based `APP action=stop` calls `/api/apps/stop`, the same canonical AppManager path as `AppsManagementSection`; a successful stop and `nothing-stopped` are distinct typed results.
- **APP action requires owner role.** `hasOwnerAccess` from `@elizaos/core` gates all `APP` writes. `VIEWS` read modes are open; write modes (`create`, `edit`, `delete`) are owner-gated.
- **Multi-turn flows.** `APP create` and `VIEWS create` use `hasPendingIntent` / `hasPendingViewsCreateIntent` to detect follow-up choice replies (`new`, `edit-N`, `cancel`). Both check a pending-task record in the runtime before routing to the create sub-handler.
- **Create flows work outside a checkout and preflight their dependencies.** `src/actions/scaffold-env.ts` resolves the min-plugin / min-project templates from the repo root first and then from the installed `elizaos` package (declared as a dependency so packaged builds ship the templates), lands new plugins in `<stateDir>/plugins` when the repo root has no plugins/ dir, and `preflightCodingDispatch` checks the orchestrator action + a coding CLI on PATH BEFORE scaffolding so a missing prerequisite answers with setup guidance instead of a dead-end error (or a half-created workdir). Keep new scaffold paths on these helpers; do not reintroduce repo-root-only resolution.
- **Build has three steps.** `tsup` compiles the main entry and the worker entry to ESM. `tsc` emits declarations only (`--emitDeclarationOnly`). `vite build:views` compiles the React view bundle separately. All three run in sequence via `bun run build`.
- **`puppeteer-core` is an optional peer dep.** `AppVerificationService` only loads it when a browser step is requested and the dep is present. Set `ELIZA_BROWSER_VERIFY_OPTIONAL=1` if you want failures there to be non-blocking.
- **`AppWorkerHostService` auto-starts persisted worker apps best-effort.** On service start it asks `AppRegistryService` for persisted entries and spawns apps whose resolved isolation is `"worker"`. Spawn failures are reported without preventing the registry entry from remaining inspectable.
- **Worker surfaces are explicit.** New app manifests declare `elizaos.app.worker: false` for static-only apps or `elizaos.app.worker: { entry: "dist/plugin.js" }` for an agent-side plugin. An absent field invokes conventional entry discovery only for legacy apps; a missing explicitly declared entry is a broken or unbuilt worker, not a static app.
- **Restricted platforms.** `isRestrictedPlatform()` in `src/actions/views.ts` returns `true` on iOS/Android store builds. Use it to gate dynamic-plugin creation flows.
- **Natural-language view routing is model-owned.** The first-party plugin does not register `viewNavigationShortcuts`, `viewCommandShortcutEvaluator`, or `viewContextEvaluator`. The model must select `VIEWS` and supply a structured `action`; show/open/close must also supply `view`. `runViewsShow` validates and resolves only that structured target and never parses the user's prose to override or repair it. Keep native/window execution deterministic after the typed action is selected.
- **Pre-edit snapshots are best-effort (#8915).** `VIEWS create`/`edit` and `APP create`/edit take a `git commit --no-verify --allow-empty` snapshot of the target workdir before dispatching the coding agent and record the SHA on a `views-snapshot`-tagged Task keyed by room/plugin. A failed snapshot (workdir not in a git work tree, no committer identity, …) only disables rollback for that edit — it must never abort the dispatch. `VIEWS rollback` resolves the most-recent snapshot for the room (or an explicit `sha`/`view`), runs `git reset --hard`, then re-registers via `load-from-directory`. On verification failure after max retries, `VerificationRoomBridgeService` surfaces a chat offer naming `VIEWS action=rollback` for plugins so the user is never left with a broken create/edit. Shell out via the injectable `GitRunner` in `views-snapshot.ts` (so tests stay deterministic); do not reach into `CodingWorkspaceService`, which is keyed by managed-workspace IDs, not local repo workdirs.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
