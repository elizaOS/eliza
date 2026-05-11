# Launch Readiness 15: Utility Apps QA

## Second-Pass Status (2026-05-05)

- Current: Workflow Builder remains a package-level stub while the user-facing route is `/automations`; Screenshare remains hidden; Electrobun menu entries still drift from renderer app entries.
- Still open: Android Contacts/Phone/WiFi packages are not imported by the host app, WiFi is absent from native entrypoints, and current tests do not catch renderer registration gaps.
- Launch gate: add host-import/native-entrypoint assertions and make Screenshare tests discoverable before treating utility apps as complete.

## Current state

The app catalog has a working client-side path for bundled utility apps. Renderer-owned internal tools are injected before server catalog data so their curated names, hero images, order, capabilities, and direct routes win over bare runtime entries (`packages/app-core/src/components/pages/AppsView.tsx:451`). The merged catalog loader also combines static catalog apps, installed apps, and registered overlay apps, then hides explicitly internal/system-only packages from normal browse (`packages/app-core/src/components/apps/catalog-loader.ts:13`, `packages/app-core/src/components/apps/helpers.ts:43`).

Visible utility/productivity surfaces are mostly hardcoded internal tools rather than self-registering `apps/*` packages: LifeOps, Plugin Viewer, Skills Viewer, Fine Tuning, Trajectory Viewer, Relationship Viewer, Memory Viewer, Runtime Debugger, Database Viewer, Log Viewer, and Workflow Builder are defined in `internal-tool-apps.ts` and route to existing shell tabs or app windows (`packages/app-core/src/components/apps/internal-tool-apps.ts:22`). Steward and ElizaMaker are also internal tools, but the default app visibility gate hides them unless explicitly configured or shown through other entry points (`packages/app-core/src/components/apps/helpers.ts:77`).

Android system utilities exist as real overlay app packages: Contacts, Phone, and WiFi each declare `androidOnly: true`, register an overlay app component, and expose a runtime plugin half (`plugins/app-contacts/package.json:31`, `plugins/app-phone/package.json:31`, `plugins/app-wifi/package.json:31`). However, I could not find their renderer side-effect imports in `packages/app/src/main.tsx` or package deps in `packages/app/package.json`, even though runtime plugin loading comments say overlay UI registration happens through those imports (`packages/agent/src/runtime/plugin-collector.ts:324`, `packages/agent/src/runtime/core-plugins.ts:35`).

Screenshare has the most complete new-style app metadata among hidden utility apps: `kind: "app"`, launch type, viewer URL, sandbox, session features, capabilities, runtime plugin, and bridge export are all declared (`plugins/app-screenshare/package.json:29`). It is intentionally hidden from Apps browse (`packages/app-core/src/components/apps/helpers.ts:50`), and I did not find a renderer import/package dependency that would make it user-discoverable through the new catalog shell.

Workflow Builder is exposed to users through the internal tool list and opens `/automations`, but the package under `plugins/app-workflow-builder` is only a minimal metadata shell with a stub `registerWorkflowBuilderApp()` (`plugins/app-workflow-builder/package.json:15`, `plugins/app-workflow-builder/src/register.ts:8`).

## Evidence reviewed with file refs

- Internal app catalog source of truth: `packages/app-core/src/components/apps/internal-tool-apps.ts:22`, `packages/app-core/src/components/apps/internal-tool-apps.ts:170`, `packages/app-core/src/components/apps/internal-tool-apps.ts:206`.
- Catalog visibility and grouping: `packages/app-core/src/components/apps/helpers.ts:43`, `packages/app-core/src/components/apps/helpers.ts:64`, `packages/app-core/src/components/apps/helpers.ts:77`, `packages/app-core/src/components/apps/helpers.ts:172`, `packages/app-core/src/components/apps/helpers.ts:317`.
- Merged app loading and overlay injection: `packages/app-core/src/components/apps/catalog-loader.ts:13`, `packages/app-core/src/components/apps/catalog-loader.ts:25`, `packages/app-core/src/components/apps/catalog-loader.ts:50`, `packages/app-core/src/components/apps/overlay-app-registry.ts:31`, `packages/app-core/src/components/apps/overlay-app-registry.ts:62`, `packages/app-core/src/components/apps/overlay-app-registry.ts:127`.
- Apps browse and launch routing: `packages/app-core/src/components/pages/AppsView.tsx:451`, `packages/app-core/src/components/pages/AppsView.tsx:466`, `packages/app-core/src/components/pages/AppsView.tsx:540`, `packages/app-core/src/components/pages/AppsView.tsx:710`, `packages/app-core/src/components/pages/AppDetailsView.tsx:777`.
- Electrobun app menu mirror: `packages/app-core/platforms/electrobun/src/application-menu.ts:4`, `packages/app-core/platforms/electrobun/src/application-menu.ts:24`.
- Renderer app imports and package dependencies: `packages/app/src/main.tsx:75`, `packages/app/src/main.tsx:81`, `packages/app/src/main.tsx:109`, `packages/app/package.json:41`, `packages/app/package.json:54`, `packages/app-core/src/platform/native-plugin-entrypoints.ts:3`.
- Android system runtime comments and plugin list: `packages/agent/src/runtime/plugin-collector.ts:324`, `packages/agent/src/runtime/core-plugins.ts:35`, `packages/agent/src/runtime/core-plugins.ts:49`.
- Android utility app packages: `plugins/app-contacts/package.json:31`, `plugins/app-contacts/src/register.ts:13`, `plugins/app-contacts/src/components/contacts-app.ts:14`, `plugins/app-phone/package.json:31`, `plugins/app-phone/src/register.ts:14`, `plugins/app-phone/src/components/phone-app.ts:14`, `plugins/app-wifi/package.json:31`, `plugins/app-wifi/src/register.ts:14`, `plugins/app-wifi/src/components/wifi-app.ts:14`.
- Hidden utility/productivity packages: `plugins/app-screenshare/package.json:29`, `plugins/app-screenshare/src/routes.ts:76`, `plugins/app-screenshare/test/routes.test.ts:122`, `plugins/app-workflow-builder/package.json:15`, `plugins/app-workflow-builder/src/register.ts:8`, `plugins/app-browser/package.json:1`, `plugins/plugin-form/package.json:20`, `plugins/app-documents/package.json:22`, `plugins/app-task-coordinator/package.json:22`.
- Catalog coverage tests: `packages/app-core/src/components/apps/catalog-coverage.test.ts:104`.

## What I could validate

- App-core catalog tests passed:
  - Command: `bunx vitest run --config packages/app-core/vitest.config.ts packages/app-core/src/components/apps/catalog-coverage.test.ts packages/app-core/src/components/apps/AppsCatalogGrid.test.tsx packages/app-core/src/components/apps/overlay-app-registry.test.ts packages/app-core/test/components/apps/overlay-app-registry-android-only.test.ts packages/app-core/src/components/pages/AppsView.test.tsx packages/app-core/src/components/chat/AppsSection.test.tsx`
  - Result: 6 test files passed, 26 tests passed.
- Android system utility plugin tests passed when run from each app directory:
  - `plugins/app-contacts`: `bunx vitest run --config ./vitest.config.ts test/plugin.test.ts` passed, 3 tests.
  - `plugins/app-phone`: `bunx vitest run --config ./vitest.config.ts test/plugin.test.ts` passed, 3 tests.
  - `plugins/app-wifi`: `bunx vitest run --config ./vitest.config.ts test/plugin.test.ts` passed, 3 tests.
- `plugins/app-workflow-builder` typechecked cleanly with `bun run typecheck`.
- Static review validates that internal tools can launch either as dedicated Electrobun app windows through `desktopOpenAppWindow` or as shell tab fallbacks (`packages/app-core/src/components/pages/AppsView.tsx:540`, `packages/app-core/src/components/pages/AppsView.tsx:737`).
- Static review validates details-page gating: only internal tools with `hasDetailsPage` opt into details first; overlay apps skip details; catalog apps with sessions/detail panels/games get details (`packages/app-core/src/components/pages/AppDetailsView.tsx:777`).
- Static review validates Android-only overlay filtering outside MiladyOS Android (`packages/app-core/src/components/apps/overlay-app-registry.ts:62`).

## What I could not validate

- I did not run a desktop, web, Android, or MiladyOS visual smoke of the Apps catalog, app windows, or overlays.
- I could not validate Android Contacts/Phone/WiFi on-device permissions, native bridge calls, dialer/contacts/WiFi side effects, or MiladyOS user-agent/platform gating.
- I could not validate Electrobun OS menu launches. Static review found menu drift, but the direct targeted command did not execute because the repo has no root `vitest.config.ts`; `packages/app-core/platforms/electrobun/src/application-menu.test.ts` was not discovered by the attempted root command.
- I could not validate Screenshare routes through a targeted test command. `plugins/app-screenshare` has no local `vitest.config.ts`, and direct root Vitest filters did not discover `plugins/app-screenshare/test/routes.test.ts` from this repo cwd. The test file itself exists and covers route/session behavior (`plugins/app-screenshare/test/routes.test.ts:122`).
- I did not validate live Plugin Viewer, Skills Viewer, Trajectory Viewer, Relationship Viewer, Memory Viewer, Runtime Debugger, Database Viewer, Log Viewer, Fine Tuning, Steward, LifeOps, or Workflow Builder UI rendering beyond static launch wiring and app-core catalog tests.

## Bugs/risks P0-P3

### P0

- None found in this bounded review.

### P1

- Android system overlay UIs appear not to be wired into the renderer app shell. Contacts/Phone/WiFi expose `./register` modules and register overlay apps only when `isElizaOS()` is true (`plugins/app-contacts/src/register.ts:13`, `plugins/app-phone/src/register.ts:14`, `plugins/app-wifi/src/register.ts:14`), and runtime code says these imports register the overlay UIs (`packages/agent/src/runtime/plugin-collector.ts:324`). But `packages/app/src/main.tsx` imports Companion, LifeOps widgets, task coordinator slots, games, Shopify, and Vincent only (`packages/app/src/main.tsx:75`, `packages/app/src/main.tsx:109`), and `packages/app/package.json` does not list `@elizaos/app-contacts`, `@elizaos/app-phone`, or `@elizaos/app-wifi` (`packages/app/package.json:41`). WiFi also depends on `@elizaos/capacitor-wifi` (`plugins/app-wifi/package.json:21`), but the app shell imports native plugin entrypoints through line 16 without WiFi (`packages/app-core/src/platform/native-plugin-entrypoints.ts:3`). Result: MiladyOS Android may load runtime plugin actions, but catalog overlay tiles/components and WiFi native bridge registration are at risk.

### P2

- Electrobun app menu is stale against the renderer internal-tool source of truth. The menu comment says it mirrors `INTERNAL_TOOL_APPS` (`packages/app-core/platforms/electrobun/src/application-menu.ts:4`), but LifeOps is marked `hasDetailsPage: true` in the menu (`packages/app-core/platforms/electrobun/src/application-menu.ts:24`) while renderer LifeOps has no details-page opt-in (`packages/app-core/src/components/apps/internal-tool-apps.ts:23`), and Workflow Builder exists in the renderer list (`packages/app-core/src/components/apps/internal-tool-apps.ts:154`) but is absent from the menu entries ending at Log Viewer (`packages/app-core/platforms/electrobun/src/application-menu.ts:102`). This can make menu launch behavior diverge from Apps browse and can omit Workflow Builder from the OS Apps menu.
- Screenshare has good new-style app metadata and route code, but is hidden from Apps browse (`packages/app-core/src/components/apps/helpers.ts:50`) and is not a dependency/import of the renderer shell. If launch expects Screen Share to be a utility app users can find and launch from Apps, it is currently not catalog-discoverable.
- Workflow Builder is user-visible through the internal tool table, but the package registration is a stub (`plugins/app-workflow-builder/src/register.ts:8`). The current user-facing app is effectively an alias to `/automations`, not a complete standalone app package.

### P3

- New app formatting is uneven across utility packages. Screenshare has rich metadata (`plugins/app-screenshare/package.json:29`), Contacts/Phone/WiFi have enough Android-only system metadata (`plugins/app-contacts/package.json:31`), Workflow Builder has only display/category/hero (`plugins/app-workflow-builder/package.json:15`), and hidden plugin-style apps such as Form, Knowledge, and Task Coordinator mostly declare only a hero image (`plugins/plugin-form/package.json:20`, `plugins/app-documents/package.json:22`, `plugins/app-task-coordinator/package.json:22`).
- Internal tool definitions are duplicated in at least two places: renderer catalog and Electrobun menu. The existing app-core catalog coverage helps, but without a shared source or parity test for the menu, this can drift again.
- Some utility apps are hidden by package name, not by richer app capability/platform metadata (`packages/app-core/src/components/apps/helpers.ts:43`). That is simple and stable, but it makes launch behavior depend on hardcoded names rather than app declarations.

## Codex-fixable work

- Add `@elizaos/app-contacts`, `@elizaos/app-phone`, and `@elizaos/app-wifi` to the renderer package dependencies where intended, import their `./register` modules behind the existing `isElizaOS()` no-op gates, and add `@elizaos/capacitor-wifi` to the native plugin entrypoint/deps if WiFi must work in the app shell.
- Add a renderer test that mocks MiladyOS Android and verifies Contacts/Phone/WiFi are registered, available, and absent on stock Android/web.
- Make Electrobun menu parity test compare `getAppMenuEntries()` against the renderer internal-tool list or move the minimal menu data to a shared non-renderer-safe module. At minimum, align LifeOps details behavior and add Workflow Builder.
- Decide whether Screenshare is intentionally hidden. If it should launch from Apps, remove it from `APPS_VIEW_HIDDEN_APP_NAMES`, add renderer package dependency/import as needed, and add catalog/launch smoke coverage.
- Either make `plugins/app-workflow-builder` a real self-registering app package or document/remove the stub so the internal `/automations` route is clearly the source of truth.
- Normalize app metadata for utility packages: display name, description, category, hero, launch type, capabilities, platform gates, and details/session declarations where applicable.

## Human visual/manual QA needed

- Apps catalog browse on desktop/web: verify section ordering, hero cards, hidden/default behavior, search, empty states, and that visible utility apps use the new app-card formatting without clipped text or missing images.
- Electrobun desktop: open each visible utility/internal app from Apps browse and from the OS menu, confirm whether it opens a dedicated app window or details page as intended, and verify back/recent-app state.
- Internal tool surfaces: Plugin Viewer, Skills Viewer, Fine Tuning, Trajectory Viewer, Relationship Viewer, Memory Viewer, Runtime Debugger, Database Viewer, Log Viewer, LifeOps, Steward, and Workflow Builder should render their expected shell tab/window and not a blank route.
- MiladyOS Android: verify Contacts/Phone/WiFi tiles appear only on MiladyOS Android, not stock Android; grant/deny permissions; test contact read/create, phone call/log behavior, WiFi scan/connect/current network, and failure states.
- Screenshare: if expected for launch, validate route creation, viewer iframe sandbox, local screenshot stream, input commands, session stop, and permission prompts on macOS.
- Workflow Builder: verify `/automations` from Apps has the right title/app framing and does not feel like a broken standalone app.

## Per-app checklist

| App | Catalog/format state | Validation | Launch QA call |
| --- | --- | --- | --- |
| LifeOps | Internal tool, featured, utility metadata, direct `/apps/lifeops` window path. | Covered by app-core catalog tests only in this review. | Manual open from Apps and Electrobun menu; menu details flag drift should be fixed. |
| Plugin Viewer | Internal tool with hero/category/capabilities and `/apps/plugins`. | Static launch wiring reviewed. | Manual render check. |
| Skills Viewer | Internal tool with hero/category/capabilities and `/apps/skills`. | Static launch wiring reviewed. | Manual render check. |
| Fine Tuning / Training | Internal tool with details page and `/apps/fine-tuning`; package has hero-only app metadata. | Static launch/details wiring reviewed. | Manual details + launch/window check. |
| Trajectory Viewer | Internal tool with `/apps/trajectories`. | Static launch wiring reviewed. | Manual render check with data/no-data states. |
| Relationship Viewer | Internal tool with `/apps/relationships`. | Static launch wiring reviewed. | Manual render check with data/no-data states. |
| Memory Viewer | Internal tool with `/apps/memories`. | Static launch wiring reviewed. | Manual render check with data/no-data states. |
| Steward | Internal tool with details page, default-hidden in Apps browse unless configured. | Static visibility/details wiring reviewed. | Manual wallet/steward launch covered by wallet QA; ensure hidden/default behavior is intentional. |
| Runtime Debugger | Internal tool with `/apps/runtime`. | Static launch wiring reviewed. | Manual render check. |
| Database Viewer | Internal tool with `/apps/database`. | Static launch wiring reviewed. | Manual render check; verify auth/readonly expectations. |
| Log Viewer | Internal tool with `/apps/logs`. | Static launch wiring reviewed. | Manual render check and log availability. |
| Workflow Builder | Internal tool visible as `/automations`; package metadata minimal; register stub. | `bun run typecheck` passed in app package. | Fix/package decision needed; manual `/automations` framing check. |
| Contacts | Android-only overlay app package with system metadata and component registration. | App plugin test passed, 3 tests. | P1 wiring risk; manual MiladyOS Android contacts permissions/read/create. |
| Phone | Android-only overlay app package with system metadata and component registration. | App plugin test passed, 3 tests. | P1 wiring risk; manual MiladyOS Android call/log/dialer permissions. |
| WiFi | Android-only overlay app package with system metadata and component registration. | App plugin test passed, 3 tests. | P1 wiring risk; add WiFi native entrypoint/deps if intended, then device QA scan/connect. |
| Screenshare | Rich new-style app metadata and routes; hidden from Apps browse. | Static route/test review only; direct test harness did not discover file. | Decide discoverability, then manual stream/viewer/input QA. |
| Browser | Plugin/runtime package, hidden from Apps browse, no app-card metadata. | Static package review only; deeper browser QA is in Launch Readiness 11. | OK as hidden infrastructure unless product expects app tile. |
| Form | Plugin-style package, hidden, hero-only app metadata. | Static package review only. | OK as hidden infrastructure unless product expects app tile. |
| Knowledge | Plugin/routes package, hidden, hero-only app metadata. | Static package review only. | OK as hidden infrastructure unless product expects app tile. |
| Task Coordinator | Hidden infrastructure package; slots imported by renderer. | Static package/import review only. | Manual coding-agent slots covered by coding QA; not a catalog app. |

## Changed paths

- `launchdocs/15-utility-apps-qa.md`

## AI QA Pass 2026-05-11 (static analysis)

Workstream 3 of the AI QA master plan (`23-ai-qa-master-plan.md`). Live dev stack is down (active secrets refactor blocks `bun run build:web`), so this pass is purely static. Scope: 11 visible + 2 hidden utility apps, all `kind=app subtype=tool` entries in `packages/app-core/src/registry/entries/apps/`.

### Architecture context

- Registry SoT is JSON-per-app under `packages/app-core/src/registry/entries/apps/` (e.g. `memory-viewer.json:1`), generated/validated against `packages/app-core/src/registry/schema.ts:288` (`appEntrySchema`).
- Visible utility apps are ALSO declared in `packages/ui/src/components/apps/internal-tool-apps.ts:22` (the renderer-side catalog with `windowPath` + `targetTab` + `heroImage` strings). Two of these (`Fine Tuning` = training, `Steward`, `ElizaMaker`) exist there with `hasDetailsPage: true` but their registry entries (`training.json:9`, `documents.json:9`) are `visible: false` — Fine Tuning is the visible internal tool while `training` registry entry is the backing route plugin.
- Route mounting for `/apps/<slug>` runs through `packages/app/src/main.tsx:687` → `packages/ui/src/desktop-runtime/AppWindowRenderer.tsx:99` (`renderInternalToolTab(tab)`), which static-imports each view from `packages/ui/src/components/pages/` and dispatches by `targetTab`. LifeOps is special-cased via boot config (`AppWindowRenderer.tsx:127`).
- Smoke test contract lives in `packages/app/test/ui-smoke/apps-session-route-cases.ts:5` (`DIRECT_ROUTE_CASES`) — that file is the canonical map of expected `[data-testid]` selectors per route.

### Modern shell baseline

"Modern shell" = imports `PageLayout` + `PagePanel` + `SidebarPanel` from `@elizaos/ui` (per Workstream 3 task spec). Reference implementation: `packages/ui/src/components/pages/MemoryViewerView.tsx:1-11`.

`AppWorkspaceChrome` (`packages/ui/src/components/workspace/AppWorkspaceChrome.tsx:257`) is a DIFFERENT modern shell (main + chat sidebar, used by LifeOps and BrowserWorkspaceView). Not equivalent to `PageLayout`; both are "modern", but the spec asked for `PageLayout`.

`ContentLayout` (used by `FineTuningView`) is a third, older shell.

### Per-app audit

| App | Registry | Route | Modern Shell | Tokens | Hero | Test ID | States | Tests | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lifeops | `packages/app-core/src/registry/entries/apps/lifeops.json:1` valid | `AppWindowRenderer.tsx:127` (LifeOpsAppWindowView via boot config) → `plugins/app-lifeops/src/components/LifeOpsPageView.tsx:970` | NO — uses `AppWorkspaceChrome` (`LifeOpsPageView.tsx:971`), not `PageLayout`. Uses `PagePanel` (`LifeOpsPageView.tsx:8`) for sub-cards only. | clean (no raw hex/rgba grep hits in LifeOpsPageView) | `/api/apps/hero/lifeops` (resolved at runtime, `internal-tool-apps.ts:28`) | `data-testid="lifeops-shell"` set via `AppWorkspaceChrome testId` prop (`LifeOpsPageView.tsx:972`) | EnablePrompt (`LifeOpsPageView.tsx:46`), `PagePanel.Loading` (`LifeOpsPageView.tsx:939`), danger `PagePanel.Notice` (`LifeOpsPageView.tsx:918`) | 105 test files under `plugins/app-lifeops/test/` | Workspace-chrome shell is legitimate but not the spec's `PageLayout`. Sub-panels use modern tokens. |
| plugin-viewer | `packages/app-core/src/registry/entries/apps/plugin-viewer.json:1` valid | `AppWindowRenderer.tsx:102` (PluginsPageView) → `PluginsView.tsx:1251` | YES — `PluginsView.tsx:29-35` imports `PageLayoutHeader`, `PagePanel`, `SidebarPanel` from `@elizaos/ui`. Uses `PagePanel.Frame` + `PagePanel` shell + `SidebarPanel` (`PluginsView.tsx:1252-1285`). | clean — uses `bg-card`, `border-border`, design-token classes | `/app-heroes/plugin-viewer.png` (file present, `packages/app/public/app-heroes/plugin-viewer.png`) | `data-testid="plugins-shell"` (`PluginsView.tsx:1257`) + `data-testid="plugins-view-page"` (`PluginsView.tsx:1252`). Smoke test uses ready-text, not selector. | empty/loading via `PagePanel.Empty`/`PagePanel.Notice` (`PluginsView.tsx:1131-1363`) | catalog tests under `packages/app-core/src/components/apps/` | testid does not match `<id>-view` convention (`plugin-viewer-view`); uses `plugins-shell`. |
| skills-viewer | `packages/app-core/src/registry/entries/apps/skills-viewer.json:1` valid | `AppWindowRenderer.tsx:104` (SkillsView) → `SkillsView.tsx:308` | YES — `SkillsView.tsx:5-14` imports `PageLayout` + `PagePanel` + `SidebarPanel`. | clean (no raw color hits) | `/app-heroes/skills-viewer.png` present | `data-testid="skills-shell"` (`SkillsView.tsx:309`) plus `skills-detail`, `skills-empty-state`, `skills-filter-empty`, `skills-detail-name` (`SkillsView.tsx:314-483`). Smoke test selector: `[data-testid="skills-shell"]`. | rich empty states (`SkillsView.tsx:337-676`) | shared catalog tests | testid does not match `<id>-view` convention. |
| trajectory-viewer | `packages/app-core/src/registry/entries/apps/trajectory-viewer.json:1` valid | `AppWindowRenderer.tsx:106` (TrajectoriesView) → `TrajectoriesView.tsx:536` | YES — `TrajectoriesView.tsx:7-14` imports `PageLayout` + `PagePanel` + `SidebarPanel`. | **VIOLATIONS** — raw rgba tuples for status colors (`TrajectoriesView.tsx:41-52`: `rgba(59, 130, 246, 0.15)`, `rgb(34, 197, 94)`, etc., 9 hardcoded colors). | `/app-heroes/trajectory-viewer.png` present | `data-testid="trajectories-view"` (`TrajectoriesView.tsx:540`) — matches `<id>-view` convention | `PagePanel.Loading`, `PagePanel.Empty`, `PagePanel.Notice` (`TrajectoriesView.tsx:543-566`) | trajectory tests in `plugins/app-training/src/core/`, `plugins/app-trajectory-logger/` | 9 raw color literals need to move to CSS vars (`--trajectory-status-active-bg` etc.). |
| relationship-viewer | `packages/app-core/src/registry/entries/apps/relationship-viewer.json:1` valid | `AppWindowRenderer.tsx:108` (RelationshipsView) → `RelationshipsView.tsx:9` → `RelationshipsWorkspaceView.tsx:374` | YES — `RelationshipsWorkspaceView.tsx:1` imports `PageLayout` + `PagePanel`. | clean | `/app-heroes/relationship-viewer.png` present | `data-testid="relationships-view"` (`RelationshipsWorkspaceView.tsx:386`) | `PagePanel.Loading`, `PagePanel.Empty` (`RelationshipsWorkspaceView.tsx:260-322`) | `relationships-utils.ts` in same dir + shared catalog tests | OK. |
| memory-viewer | `packages/app-core/src/registry/entries/apps/memory-viewer.json:1` valid | `AppWindowRenderer.tsx:110` (MemoryViewerView) → `MemoryViewerView.tsx:651` | YES — reference impl. `MemoryViewerView.tsx:1-11` imports `PageLayout` + `PagePanel` + `SidebarPanel`. | clean — uses scoped CSS classes (`memory-type-badge-<key>`, defined in `packages/ui/src/styles/brand-gold.css`). Comment at `MemoryViewerView.tsx:42-45` explicitly notes the tokenization. | `/app-heroes/memory-viewer.png` present | `data-testid="memory-viewer-view"` (`MemoryViewerView.tsx:654`) — matches convention | `PagePanel.Loading` (`MemoryViewerView.tsx:218,363`), `PagePanel.Empty` (`MemoryViewerView.tsx:231,369`), `PagePanel.SummaryCard` (`MemoryViewerView.tsx:504`), danger fallback (`MemoryViewerView.tsx:223,365`) | `packages/app-core/test/app/memory-relationships.real.e2e.test.ts` | Reference shell. Use as template for the others. |
| runtime-debugger | `packages/app-core/src/registry/entries/apps/runtime-debugger.json:1` valid | `AppWindowRenderer.tsx:112` (RuntimeView) → `RuntimeView.tsx:610` | YES — `RuntimeView.tsx:5-11` imports `PageLayout` + `PagePanel` + `SidebarPanel`. | partial — uses CSS vars (`var(--card)`, `var(--bg)`) but mixes in raw rgba literals (e.g. `rgba(255,255,255,0.14)`, `rgba(15,23,42,0.12)`) inline at `RuntimeView.tsx:502,519,536`. These are alpha-channel decorations, not semantic. | `/app-heroes/runtime-debugger.png` present | `data-testid="runtime-view"` (`RuntimeView.tsx:613`) + `data-testid="runtime-sidebar"` (smoke expects both). | `PagePanel.Empty` (`RuntimeView.tsx:623,634,749`) | live test `packages/app-core/test/live-agent/runtime-debug.live.e2e.test.ts`, `real-runtime-helpers.live.e2e.test.ts` | The 30+ rgba alpha literals in deeply nested `className` strings are technical debt; ship to brand-token CSS vars. |
| database-viewer | `packages/app-core/src/registry/entries/apps/database-viewer.json:1` valid | `AppWindowRenderer.tsx:114` (DatabasePageView wraps DatabaseView) → `DatabaseView.tsx:425` | YES — `DatabaseView.tsx:5-12` imports `PageLayout` + `PagePanel` + `SidebarPanel`. | partial — same rgba issue as RuntimeView. `DatabaseView.tsx:254` raw `rgba(34,197,94,0.5)` shadow; `DatabaseView.tsx:282,410,640,683,866,893` repeated rgba alpha literals in inline classNames. | `/app-heroes/database-viewer.png` present | `data-testid="database-view"` (`DatabaseView.tsx:426`) | `PagePanel.Empty` (`DatabaseView.tsx:453,477,526,829`) | `packages/app-core/test/live-agent/database-conversation.live.e2e.test.ts` + db-check test suite | Same alpha-token-debt pattern. |
| log-viewer | `packages/app-core/src/registry/entries/apps/log-viewer.json:1` valid | `AppWindowRenderer.tsx:117` (LogsView) → `LogsView.tsx:95` | PARTIAL — `LogsView.tsx:5-11` imports `PagePanel` only, NOT `PageLayout` or `SidebarPanel`. Page wraps content in a plain `<div className="flex h-full flex-col gap-3">`. | clean | `/app-heroes/log-viewer.png` present | `data-testid="logs-view"` (`LogsView.tsx:95`) + `data-testid="log-entry"` (`LogsView.tsx:259`) | `PagePanel.Empty` (`LogsView.tsx:231`) | none specific to LogsView found | Missing the `PageLayout`/`SidebarPanel` wrapper. Page is effectively a single column. P2. |
| training (hidden) | `packages/app-core/src/registry/entries/apps/training.json:1` valid, `visible: false` | route mounted via `AppWindowRenderer.tsx:118` for `targetTab=fine-tuning`, `routePlugin.exportName=trainingPlugin` (`training.json:25-29`) → `FineTuningView.tsx:499` | NO — `FineTuningView.tsx:1-19` imports `ContentLayout` not `PageLayout`/`PagePanel`/`SidebarPanel`. The `TrainingDashboard` fallback (`packages/ui/src/components/training/TrainingDashboard.tsx:1`) imports only `Button, Input`. | **VIOLATIONS** — `TrainingDashboard.tsx:33,142,335` use raw Tailwind `bg-red-500/10`, `text-red-500` instead of `danger` tokens. | `/api/apps/hero/training` (runtime-resolved) | `data-testid="fine-tuning-view"` set at `FineTuningView.tsx:492` and `501` | `FineTuningView.tsx:489-497` has pageLoading state; empty/error states present | `plugins/app-training/test/training-api.live.e2e.test.ts` + `src/core/*.test.ts` + `src/routes/trajectory-routes.test.ts` | Both shell + token issues. P1 if Fine Tuning is a launch-shipped app. |
| documents (hidden) | `packages/app-core/src/registry/entries/apps/documents.json:1` valid, `visible: false` (label `"Knowledge"`) | DocumentsView is not in `renderInternalToolTab` switch (`AppWindowRenderer.tsx:101-133`); it's mounted from inside chat / settings flows, not `/apps/<id>`. | NO — `DocumentsView.tsx:1` imports `PagePanel` only. Wraps in `<div>` (`DocumentsView.tsx:1232`). | clean | no `/app-heroes/documents.png`, no `/api/apps/hero/documents` declared in registry. `documents.json` has no `heroImage`. | `data-testid="documents-view"` (`DocumentsView.tsx:1234`) | `PagePanel.Empty` (`DocumentsView.tsx:1088,1098,1110,1124`), `PagePanel.Notice` (`DocumentsView.tsx:1258`) | `plugins/app-documents/test/documents-api.live.e2e.test.ts`, `documents-live.e2e.test.ts` | Hidden in catalog (correctly — surface lives in chat side panel). |

### Findings (P0/P1/P2/P3)

#### P0

- None. All visible utility apps have a registry entry, a mounted route, a `data-testid` rendered, and an `AppWindowRenderer` dispatch branch.

#### P1

- **Fine Tuning fails design tokens and shell convention.** `plugins/app-training/src/ui/FineTuningView.tsx:1-19` uses `ContentLayout` not `PageLayout`. The fallback `packages/ui/src/components/training/TrainingDashboard.tsx:33,142,335` uses raw Tailwind palette (`bg-red-500/10`, `text-red-500`). This is the only `subtype: "tool"` registry entry whose component does not use any of the modern app shells. If Fine Tuning ships as a launch-week visible app (it is in `internal-tool-apps.ts:56` with `hasDetailsPage: true` and `windowPath: /apps/fine-tuning`), it needs a `PageLayout` + token migration before launch.
- **TrajectoriesView ships hardcoded color literals.** `packages/ui/src/components/pages/TrajectoriesView.tsx:41-52` declares 9 raw `rgba(...)` / `rgb(...)` color triples for status/source pills. These are not theme-aware and will not respond to dark-mode token switches. Migrate to scoped CSS classes (`memory-type-badge-<key>` pattern at `packages/ui/src/styles/brand-gold.css` is the precedent — see `MemoryViewerView.tsx:42-45` comment).
- **LogsView is missing the sidebar half of the shell.** `packages/ui/src/components/pages/LogsView.tsx:5-11` imports only `PagePanel`, not `PageLayout` or `SidebarPanel`. The component is a single-column `<div>` (`LogsView.tsx:95`). Other utility tools (Memory, Skills, Trajectories, Database, Runtime, Relationships) use the two-pane sidebar layout. Either add a filter sidebar (level, source, time range) or downgrade to P2 if the product decision is "logs are a single column on purpose".

#### P2

- **LifeOps uses `AppWorkspaceChrome` (chat-rail shell), not `PageLayout`.** `plugins/app-lifeops/src/components/LifeOpsPageView.tsx:971`. Two modern shells coexist (chat-rail vs sidebar-rail). If the spec wants utility apps unified on `PageLayout`, LifeOps and Browser are off-pattern. Likely a deliberate product choice — LifeOps wants the assistant pane visible — but worth confirming.
- **RuntimeView + DatabaseView mix `var(--card)` with raw `rgba(...)` alpha decorations.** `RuntimeView.tsx:502,519,536` and `DatabaseView.tsx:254,282,410,640,683,866,893` use long `className` strings that mix CSS vars for color with hardcoded `rgba(255,255,255,0.14)` / `rgba(15,23,42,0.12)` alpha highlights. These are decorative shadow / inset-line literals; they should still be tokens (`--card-inset-highlight`, `--card-shadow-dark`) so dark-mode lifts work uniformly.
- **`data-testid` naming is inconsistent across utility apps.** Spec selector convention (per task prompt) is `[data-testid="<id>-view"]`. Actual:
  - Matches convention: `memory-viewer-view`, `trajectories-view`, `relationships-view`, `database-view`, `runtime-view`, `logs-view`, `documents-view`, `fine-tuning-view`.
  - Off-convention: `lifeops-shell` (`LifeOpsPageView.tsx:972`), `skills-shell` (`SkillsView.tsx:309`), `plugins-shell` (`PluginsView.tsx:1257`).
  - The smoke test `apps-session-route-cases.ts:5` accepts the actual names, so this is a doc/spec-vs-impl drift, not a runtime bug. Either update the spec wording or rename the test IDs.

#### P3

- **Documents (Knowledge) has no hero image** in either form — `documents.json:1` declares no `heroImage`, no file at `packages/app/public/app-heroes/documents.png`, no `/api/apps/hero/documents` declared in `internal-tool-apps.ts`. Hidden today so it does not surface in Apps browse, but if it gets promoted (see "diff" below) it will fall through `resolveAppHeroImage(packageName, null)` to generated artwork.
- **Training app description duplicates `"documents"` tag.** `documents.json:7`: `"tags": ["documents", "documents"]`. Cosmetic — does not break anything.
- **No per-app unit test for the React view layer.** None of `MemoryViewerView`, `LogsView`, `DatabaseView`, `RuntimeView`, `TrajectoriesView`, `RelationshipsView`, `SkillsView`, `PluginsView`, `DocumentsView`, `FineTuningView` have direct `.test.tsx` siblings. Coverage is route-level smoke (`packages/app/test/ui-smoke/apps-session-*.spec.ts`) plus backend live e2e tests. If any of these gets non-trivial new state logic, that's a coverage gap.

### Stale / legacy shell

Utility apps NOT on the spec's `PageLayout` modern shell, ordered by severity:

1. **`fine-tuning`** (`plugins/app-training/src/ui/FineTuningView.tsx:1-19`) — uses `ContentLayout`. No `SidebarPanel`. Visible-shipping internal tool.
2. **`log-viewer`** (`packages/ui/src/components/pages/LogsView.tsx:5-11`) — imports `PagePanel` only, no `PageLayout` or `SidebarPanel`. Visible-shipping internal tool.
3. **`lifeops`** (`plugins/app-lifeops/src/components/LifeOpsPageView.tsx:971`) — uses `AppWorkspaceChrome` (modern but different shell — chat rail + main). Intentional.
4. **`documents`** (`packages/ui/src/components/pages/DocumentsView.tsx:1`) — imports `PagePanel` only, no `PageLayout` or `SidebarPanel`. Hidden; surfaced via chat/settings, not `/apps/<id>` directly.

All other visible utility apps (`plugin-viewer`, `skills-viewer`, `trajectory-viewer`, `relationship-viewer`, `memory-viewer`, `runtime-debugger`, `database-viewer`) import the canonical `PageLayout` + `PagePanel` + `SidebarPanel` set.

### Diff: `generate-apps.ts` vs this doc

Apps in `packages/app-core/src/registry/generate-apps.ts:27` (`INTERNAL_TOOLS`):
`lifeops, plugin-viewer, skills-viewer, trajectory-viewer, relationship-viewer, memory-viewer, runtime-debugger, database-viewer, log-viewer` — 9 entries.

Apps with `subtype: "tool"` in `packages/app-core/src/registry/entries/apps/*.json`:
The 9 above PLUS `training.json:21` (`subtype: "tool"`, `visible: false`) and `documents.json:21` (`subtype: "tool"`, `visible: false`). `generate-apps.ts` does NOT emit training/documents — they were added directly to the JSON tree (probably by another migration pass), giving us 11 total `subtype: "tool"` entries.

Apps in `packages/ui/src/components/apps/internal-tool-apps.ts:22` (the renderer catalog):
`lifeops, plugin-viewer, skills-viewer, training (Fine Tuning), trajectory-viewer, relationship-viewer, memory-viewer, steward, runtime-debugger, database-viewer, elizamaker, log-viewer` — 12 entries.

Drift items:

- `steward` and `elizamaker` are in `internal-tool-apps.ts:99,132` (12 entries) but NOT under `entries/apps/` with `subtype: "tool"`. Both have their own registry entries elsewhere (e.g. `entries/apps/steward.json` for steward, no ElizaMaker JSON found) with different subtypes (steward is `subtype: "trading"`).
- `training` (Fine Tuning) IS in `internal-tool-apps.ts:56` and IS in `entries/apps/training.json` but is `visible: false` in the registry while the renderer catalog ships it visible. This is the canonical visibility split — the registry visibility flag drives `/api/catalog/apps`, while the renderer-only internal-tool list drives the in-app launcher. Working as designed (per `catalog-routes.ts:69`), but worth a code comment near `training.json` explaining the split.
- `documents` (Knowledge) is registry-only — no entry in `internal-tool-apps.ts`. Surfaced via chat/settings panel only.

### Severity totals

- P0: 0
- P1: 3 (Fine Tuning shell+tokens, TrajectoriesView raw rgba palette, LogsView missing PageLayout)
- P2: 3 (LifeOps off-pattern, RuntimeView+DatabaseView alpha-literal drift, testid naming inconsistency)
- P3: 3 (Documents missing hero, training.json duplicate tag, no per-view unit tests)

### Top-3 worst offenders

1. `plugins/app-training/src/ui/FineTuningView.tsx:1-19` — does not use any of the modern shells (`PageLayout`/`PagePanel`/`SidebarPanel`) and the fallback `packages/ui/src/components/training/TrainingDashboard.tsx:33,142,335` ships raw `bg-red-500/10` / `text-red-500` instead of `danger` tokens.
2. `packages/ui/src/components/pages/TrajectoriesView.tsx:41-52` — 9 hardcoded `rgba(...)` / `rgb(...)` color literals for status pills, bypassing the design-token system that the rest of the file (and the closely-related `MemoryViewerView`) follows.
3. `packages/ui/src/components/pages/LogsView.tsx:5-11` — modern `PagePanel` import without `PageLayout`/`SidebarPanel`; the page is a single-column `<div>` (`LogsView.tsx:95`), inconsistent with every other visible viewer in the utility group.
