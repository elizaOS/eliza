# @elizaos/plugin-app-control

Gives an Eliza agent the ability to launch, close, list, scaffold, and verify Eliza apps, manage UI views, and change the app background.

## Purpose / role

This plugin registers three actions, one natural-language shortcut set, two evaluators, one provider, and four services. It exposes those capabilities to any Eliza agent that loads it; it is opt-in (not default-enabled). All runtime communication with the Eliza dashboard happens over loopback HTTP (`/api/apps/*`, `/api/views/*`) discovered via `resolveServerOnlyPort`.

## Plugin surface

### Actions

| Name | File | Description |
|---|---|---|
| `APP` | `src/actions/app.ts` | Unified app control. Sub-modes: `launch`, `relaunch`, `load_from_directory`, `list`, `create`. `create` runs a multi-turn scaffold+coding-agent flow. Owner-gated. |
| `VIEWS` | `src/actions/views.ts` | Manage UI views contributed by plugins. Sub-modes: `list`, `current`, `show`/`open`, `search`, `manager`, `broadcast`, `interact`, `pin`, `window`, `create`, `edit`, `icon`, `rollback`, `delete`/`remove`. Create/edit/icon/rollback/delete are owner-gated; read modes are open. `rollback` resets a created/edited view-or-plugin workdir to the pre-edit git snapshot taken before the coding agent ran (#8915) and re-registers it via `load-from-directory`. |
| `BACKGROUND` | `src/actions/background.ts` | Change the unified app background from chat. Ops: `set` (color name/hex, a named **programmable GLSL shader** preset — `aurora`/`lava`/`plasma`/`waves`/`nebula` — plus relative uniform tweaks like *slower*/*brighter*/*bigger* (#10694), an uploaded image attachment, or a generated image from a prompt), `undo`, `redo`, `reset`. The action names a preset id + uniform patch only; the GLSL source lives in `@elizaos/ui` (`backgrounds/shader-presets.ts`) where `useBackgroundApplyChannel` resolves id→source, validates it, and `ProgrammableShaderBackground` renders it via three.js with a compile-validate + frame-watchdog + context-loss-recovery + reduced-motion + color-field fallback. Broadcasts a `background:apply` view event via `POST /api/views/events/broadcast`; the renderer applies it to the shared `BackgroundConfig` store. Drives the SAME background as the `/background` view — there is no separate homescreen-scene surface. |

### Evaluators

| Name | File | Description |
|---|---|---|
| `viewNavigationRoutingEvaluator` | `src/evaluators/view-navigation-routing.ts` | `responseHandlerEvaluator` that inspects agent responses and automatically routes to the appropriate view via the VIEWS action. |
| `viewFollowupRoutingEvaluator` | `src/evaluators/view-followup-routing.ts` | `responseHandlerEvaluator` that detects follow-up intent (create/delete/update) from agent output and dispatches the VIEWS action accordingly. |

### Shortcuts

| Name | File | Description |
|---|---|---|
| `viewNavigationShortcuts` | `src/shortcuts.ts` | Natural-language pre-LLM shortcuts for explicit view navigation phrases such as "open settings"; target the existing `VIEWS` action with `action=show` and are gated by `ELIZA_SHORTCUTS_NL=1`. |

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

View source lives in `src/views/ViewManagerView.tsx` (exports both `ViewManagerView` and `ViewManagerTuiView`). Bundled separately by `vite.config.views.ts` into `dist/views/bundle.js`.

## Layout

```
src/
  index.ts                        Plugin entry; exports appControlPlugin
  types.ts                        API response shapes (InstalledAppInfo, AppRunSummary, AppLaunchResult, AppStopResult)
  shortcuts.ts                    Pre-LLM natural-language shortcuts for explicit view navigation
  params.ts                       Option normalisation + verb/noun extraction helpers
  resolve.ts                      App/run name resolution (exact + substring match)
  protected-apps.ts               List of built-in apps that cannot be deleted
  register-terminal-view.tsx      Registers the TUI view at runtime
  client/
    api.ts                        AppControlClient — loopback HTTP to /api/apps/*
  actions/
    app.ts                        APP action dispatcher; imports sub-handlers below
    app-launch.ts                 launch sub-handler
    app-relaunch.ts               relaunch sub-handler (stop + launch, optional verify)
    app-list.ts                   list sub-handler
    app-load-from-directory.ts    load_from_directory sub-handler
    app-create.ts                 create sub-handler (multi-turn scaffold + coding agent)
    scaffold-env.ts               shared template/plugins-dir resolution + coding-dispatch preflight for the create flows
    background.ts                 BACKGROUND action (set color/shader-preset/image/generate, tweak, undo, redo, reset)
    views.ts                      VIEWS action dispatcher
    views-client.ts               ViewsClient — loopback HTTP to /api/views/*
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
    ViewManagerSpatialView.tsx    Spatial/XR variant of the view manager component
  evaluators/
    view-followup-routing.ts      viewFollowupRoutingEvaluator — dispatches VIEWS on follow-up intent
    view-navigation-routing.ts    viewNavigationRoutingEvaluator — routes to view from agent response
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
    ViewManagerView.tsx           React view component; exports ViewManagerView + ViewManagerTuiView
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
- **APP action requires owner role.** `hasOwnerAccess` from `@elizaos/core` gates all `APP` writes. `VIEWS` read modes are open; write modes (`create`, `edit`, `delete`) are owner-gated.
- **Multi-turn flows.** `APP create` and `VIEWS create` use `hasPendingIntent` / `hasPendingViewsCreateIntent` to detect follow-up choice replies (`new`, `edit-N`, `cancel`). Both check a pending-task record in the runtime before routing to the create sub-handler.
- **Create flows work outside a checkout and preflight their dependencies.** `src/actions/scaffold-env.ts` resolves the min-plugin / min-project templates from the repo root first and then from the installed `elizaos` package (declared as a dependency so packaged builds ship the templates), lands new plugins in `<stateDir>/plugins` when the repo root has no plugins/ dir, and `preflightCodingDispatch` checks the orchestrator action + a coding CLI on PATH BEFORE scaffolding so a missing prerequisite answers with setup guidance instead of a dead-end error (or a half-created workdir). Keep new scaffold paths on these helpers; do not reintroduce repo-root-only resolution.
- **Build has three steps.** `tsup` compiles the main entry and the worker entry to ESM. `tsc` emits declarations only (`--emitDeclarationOnly`). `vite build:views` compiles the React view bundle separately. All three run in sequence via `bun run build`.
- **`puppeteer-core` is an optional peer dep.** `AppVerificationService` only loads it when a browser step is requested and the dep is present. Set `ELIZA_BROWSER_VERIFY_OPTIONAL=1` if you want failures there to be non-blocking.
- **`AppWorkerHostService` auto-starts persisted worker apps best-effort.** On service start it asks `AppRegistryService` for persisted entries and spawns apps whose resolved isolation is `"worker"`. Spawn failures are reported without preventing the registry entry from remaining inspectable.
- **Restricted platforms.** `isRestrictedPlatform()` in `src/actions/views.ts` returns `true` on iOS/Android store builds. Use it to gate dynamic-plugin creation flows.
- **`resolveIntentView` is a RETAINED #10471 fast-path allow-list, not a string smell.** The deterministic intent→view matcher in `src/actions/views-show.ts` (`matchViewCommand` + `INTENT_VIEW_RULES`) is intentionally kept: it is multilingual by construction (EN + ES/FR/DE/ZH/JA/KO), fires only as a fallback after normal id/label/fuzzy resolution returns nothing, never overrides an explicit planner navigation, and is the local-first safety net a small/on-device planner relies on for cross-language navigation. Do not "clean it up" into an English-only path or delete it; extend the rules multilingually and keep them anchored on a possessive/navigation-verb + surface noun. Full written justification lives on `resolveIntentView`.
- **Pre-edit snapshots are best-effort (#8915).** `VIEWS create`/`edit` and `APP create`/edit take a `git commit --no-verify --allow-empty` snapshot of the target workdir before dispatching the coding agent and record the SHA on a `views-snapshot`-tagged Task keyed by room/plugin. A failed snapshot (workdir not in a git work tree, no committer identity, …) only disables rollback for that edit — it must never abort the dispatch. `VIEWS rollback` resolves the most-recent snapshot for the room (or an explicit `sha`/`view`), runs `git reset --hard`, then re-registers via `load-from-directory`. On verification failure after max retries, `VerificationRoomBridgeService` surfaces a chat offer naming `VIEWS action=rollback` for plugins so the user is never left with a broken create/edit. Shell out via the injectable `GitRunner` in `views-snapshot.ts` (so tests stay deterministic); do not reach into `CodingWorkspaceService`, which is keyed by managed-workspace IDs, not local repo workdirs.

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

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — CLI / tooling:**
- The real command/flow invocation transcript (args in, stdout/stderr, exit code) and the artifacts it generated (files, scaffolds, manifests, screenshots/recordings).
- Failure paths: bad args, missing deps, partial state, permission/network errors.
- A recording/log of the actual run end to end — not a unit test of one helper.
- Any model interaction captured as a live trajectory and reviewed.
<!-- END: evidence-and-e2e-mandate -->
