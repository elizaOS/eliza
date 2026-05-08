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
