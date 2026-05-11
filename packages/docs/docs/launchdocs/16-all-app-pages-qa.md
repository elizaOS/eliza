# Launch Readiness 16: All App Pages QA

## Second-Pass Status (2026-05-05)

- Superseded: route smoke coverage exists in `packages/app/test/ui-smoke/all-pages-clicksafe.spec.ts` and is now mandatory through `packages/app` `test:e2e`.
- Still open: overlay direct-route filtering is inconsistent, Phone/Messages/Contacts can silently fall back to chat outside Android, `/apps/tasks` semantics are confusing, and app-window/native overlay rendering is not covered end to end.
- Launch gate: extend the Playwright smoke to representative app-window and native overlay URLs before calling all pages fully verified.

## Current state

The launch host is `packages/app`, with shared page rendering and navigation in `packages/app-core`. The same React renderer is used by web, Capacitor mobile, and Electrobun desktop; desktop adds detached surface windows and per-app windows, while mobile adds native WebView configuration and Android-only phone surfaces.

The app config currently identifies the app as `elizaOS` / `ai.elizaos.app`, sets `@elizaos/app-lifeops` as the configured default app, and feeds the same config into Capacitor, main React boot, mobile build scripts, and desktop identity (`packages/app/app.config.ts:21-35`). Capacitor builds use `dist`, `https` schemes, platform-specific WebView settings, and allow-navigation entries for local/cloud/game hosts (`packages/app/capacitor.config.ts:4-50`).

### Route and page inventory

| Surface | Canonical route or entry | Web | iOS | Android | Desktop | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Chat | `/chat` | Yes | Yes | Yes | Yes | Default fallback for unknown tabs and several disabled surfaces. |
| Phone | `/phone` | Falls back to Chat | Falls back to Chat | Native Android only | Falls back to Chat | Gated by `isAndroidPhoneSurfaceEnabled()` (`packages/app-core/src/navigation/index.ts:115-129`, `packages/app-core/src/App.tsx:387-394`). |
| Messages | `/messages` | Falls back to Chat | Falls back to Chat | Native Android only | Falls back to Chat | Same Android gate (`packages/app-core/src/App.tsx:395-402`). |
| Contacts | `/contacts` | Falls back to Chat | Falls back to Chat | Native Android only | Falls back to Chat | Same Android gate (`packages/app-core/src/App.tsx:403-410`). |
| Apps hub | `/apps` | Yes | Yes | Yes | Yes | Renders `AppsPageView` when app navigation is enabled (`packages/app-core/src/App.tsx:424-431`). |
| App details | `/apps/<slug>/details` | Yes | Yes | Yes | Yes | Parsed by `AppsView` and rendered by `AppDetailsView` for opt-in apps (`packages/app-core/src/components/pages/AppsView.tsx:113-129`, `packages/app-core/src/components/pages/AppDetailsView.tsx:777-800`). |
| App direct launch | `/apps/<slug>` | Yes | Yes | Yes | Yes | Auto-launches matching app slug once catalog is loaded (`packages/app-core/src/components/pages/AppsView.tsx:867-889`). |
| LifeOps | `/apps/lifeops` | Yes | Yes | Yes | Yes | Boot-config injected page, separate from generic `TabContentView` wrapping (`packages/app-core/src/App.tsx:411-414`). |
| Tasks / workflows | `/apps/tasks`, `/automations` | Yes | Yes | Yes | Yes | `/apps/tasks` maps to automations; Workflow Builder is an internal tool targeting `/automations` (`packages/app-core/src/navigation/index.ts:410-414`, `packages/app-core/src/components/apps/internal-tool-apps.ts:153-163`). |
| Browser workspace | `/browser` | Yes when enabled | Yes when enabled | Yes when enabled | Yes plus detached window | Navigation group can be hidden by feature flags (`packages/app-core/src/navigation/index.ts:247-262`). |
| Stream | `/stream` | Yes when enabled | Yes when enabled | Yes when enabled | Yes | Navigation group can be hidden by feature flags (`packages/app-core/src/navigation/index.ts:214-224`, `packages/app-core/src/App.tsx:422-423`). |
| Character editor | `/character`, `/character/select`, `/character/documents` | Yes | Yes | Yes | Yes | Character tabs share `CharacterEditor` (`packages/app-core/src/App.tsx:439-448`). |
| Wallet / inventory | `/wallet` | Yes when wallet enabled | Yes when wallet enabled | Yes when wallet enabled | Yes | `inventory` tab renders `InventoryView`; Steward internal app routes to `/apps/inventory` (`packages/app-core/src/navigation/index.ts:202-205`, `packages/app-core/src/App.tsx:449-457`). |
| Connectors | `/connectors` | Yes | Yes | Yes | Yes plus detached window | Also accepts legacy `/settings/connectors` (`packages/app-core/src/navigation/index.ts:350-352`). |
| Plugins | `/apps/plugins` | Yes | Yes | Yes | Yes plus detached window/app window | Internal tool app and apps sub-tab (`packages/app-core/src/components/apps/internal-tool-apps.ts:34-44`). |
| Skills | `/apps/skills` | Yes | Yes | Yes | Yes plus app window | Internal tool app (`packages/app-core/src/components/apps/internal-tool-apps.ts:45-54`). |
| Fine Tuning | `/apps/fine-tuning` | Yes | Yes | Yes | Yes plus details/app window | Internal tool with details page (`packages/app-core/src/components/apps/internal-tool-apps.ts:55-66`). |
| Trajectories | `/apps/trajectories` | Yes | Yes | Yes | Yes plus app window | Internal tool (`packages/app-core/src/components/apps/internal-tool-apps.ts:67-76`). |
| Relationships | `/apps/relationships` | Yes | Yes | Yes | Yes plus app window | Internal tool (`packages/app-core/src/components/apps/internal-tool-apps.ts:77-87`). |
| Memories | `/apps/memories` | Yes | Yes | Yes | Yes plus app window | Internal tool (`packages/app-core/src/components/apps/internal-tool-apps.ts:88-97`). |
| Runtime debugger | `/apps/runtime` | Yes | Yes | Yes | Yes plus app window | Internal tool (`packages/app-core/src/components/apps/internal-tool-apps.ts:110-120`). |
| Database viewer | `/apps/database` | Yes | Yes | Yes | Yes plus app window | Internal tool (`packages/app-core/src/components/apps/internal-tool-apps.ts:121-130`). |
| Log viewer | `/apps/logs` | Yes | Yes | Yes | Yes plus app window | Internal tool (`packages/app-core/src/components/apps/internal-tool-apps.ts:143-152`). |
| Settings | `/settings`, `/settings/voice` | Yes | Yes | Yes | Yes plus detached settings window | Voice legacy route maps to settings (`packages/app-core/src/navigation/index.ts:315`, `packages/app-core/src/App.tsx:467-477`). |
| Desktop workspace | `/desktop` | Web route exists | N/A | N/A | Yes | Renders `DesktopWorkspaceSection` (`packages/app-core/src/App.tsx:534-538`). |
| Detached desktop surfaces | `?shell=surface&tab=<surface>` | N/A | N/A | N/A | Yes | Browser, chat, release, triggers, plugins, connectors, cloud (`packages/app-core/src/platform/window-shell.ts:4-21`, `packages/app-core/src/shell/DetachedShellRoot.tsx:167-223`). |
| Desktop app windows | `?appWindow=1#/apps/<slug>` | N/A | N/A | N/A | Yes | Internal tool, overlay app, or registry iframe renderer (`packages/app-core/src/shell/AppWindowRenderer.tsx:1-10`, `packages/app-core/src/shell/AppWindowRenderer.tsx:412-459`). |

The canonical tab list contains chat, phone, messages, contacts, apps, app tools, character, wallet, browser, stream, automations, settings, logs, runtime, database, and desktop tabs (`packages/app-core/src/navigation/index.ts:32-64`). Visible navigation groups are filtered by app, phone, stream, wallet, and browser flags (`packages/app-core/src/navigation/index.ts:175-262`).

### App inventory

Host-bundled app dependencies in `packages/app` are:

- `@elizaos/app-2004scape`, `@elizaos/app-babylon`, `@elizaos/app-companion`, `@elizaos/app-defense-of-the-agents`, `@elizaos/app-hyperscape`, `@elizaos/app-lifeops`, `@elizaos/app-scape`, `@elizaos/app-shopify`, `@elizaos/app-steward`, `@elizaos/app-task-coordinator`, `@elizaos/app-training`, and `@elizaos/app-vincent` (`packages/app/package.json:41-53`).

Main boot side-effect imports register companion, LifeOps widgets, task coordinator slots, game UI surfaces, Shopify, and Vincent (`packages/app/src/main.tsx:75-112`). The boot config injects LifeOps, training, Steward, Vincent, companion, and task-coordinator components into app-core (`packages/app/src/main.tsx:250-290`).

Internal tool apps shown through the Apps catalog are LifeOps, Plugin Viewer, Skills Viewer, Fine Tuning, Trajectory Viewer, Relationship Viewer, Memory Viewer, Steward, Runtime Debugger, Database Viewer, ElizaMaker, Log Viewer, and Workflow Builder (`packages/app-core/src/components/apps/internal-tool-apps.ts:22-164`).

Default catalog visibility is intentionally narrow:

- Hidden from AppsView: app host, browser bridge extension, browser/form/knowledge/screenshare/task-coordinator utility apps, and Android-only contacts/phone/wifi (`packages/app-core/src/components/apps/helpers.ts:43-58`).
- Featured/default visible: LifeOps, Companion, Defense of the Agents, and ClawVille (`packages/app-core/src/components/apps/helpers.ts:64-75`).
- Default hidden unless configured or wallet-scoped: ElizaMaker, Hyperliquid, Polymarket, Shopify, Steward, and Vincent (`packages/app-core/src/components/apps/helpers.ts:77-90`).
- AppsView only shows configured default apps, internal tools, or curated game apps unless `VITE_PUBLIC_SHOW_ALL_APPS` is active (`packages/app-core/src/components/apps/helpers.ts:172-231`).

Route-bearing app packages reviewed:

- Game/session apps: `plugins/app-2004scape/src/routes.ts:1811`, `plugins/app-babylon/src/routes.ts:535`, `plugins/app-clawville/src/routes.ts:836`, `plugins/app-defense-of-the-agents/src/routes.ts:2068`, `plugins/app-scape/src/routes.ts:882`, `plugins/app-hyperscape/src/routes.ts`.
- Utility/native route apps: `plugins/app-screenshare/src/routes.ts:119`, `plugins/app-training/src/setup-routes.ts:23-94`, `plugins/app-documents/src/setup-routes.ts:18-66`.
- Plugin route loaders: `plugins/app-shopify/src/register-routes.ts:1-6`, `plugins/app-vincent/src/register-routes.ts:1-6`, `plugins/app-polymarket/src/register-routes.ts:1-6`, `plugins/app-hyperliquid/src/register-routes.ts:1-6`, `plugins/app-steward/src/register-routes.ts:1-6`.

Android-only overlay apps declare `androidOnly: true` in their overlay definitions: Phone (`plugins/app-phone/src/components/phone-app.ts:14-26`), Contacts (`plugins/app-contacts/src/components/contacts-app.ts:14-26`), and WiFi (`plugins/app-wifi/src/components/wifi-app.ts:14-26`). The overlay API comment says these should be hidden on stock Android, iOS, desktop, and web, with filtering performed by `getAvailableOverlayApps()` (`packages/app-core/src/components/apps/overlay-app-api.ts:41-52`).

### Button and action inventory

Shared header buttons include desktop nav group buttons, mobile bottom-nav buttons, settings, language, theme, cloud billing/status, and Tasks & Events (`packages/app-core/src/components/shell/Header.tsx:420-563`, `packages/app-core/src/components/shell/Header.tsx:641-672`). Mobile chat has explicit Chats, Chat, and Tasks & Events surface buttons (`packages/app-core/src/App.tsx:677-711`).

AppsView actions include catalog load/merge, desktop app-window open, game-window open, details-first launch routing, inline internal tool navigation, overlay app activation, runtime app launch, external URL open, favorite toggle, stop run, and always-on-top toggle (`packages/app-core/src/components/pages/AppsView.tsx:426-497`, `packages/app-core/src/components/pages/AppsView.tsx:540-632`, `packages/app-core/src/components/pages/AppsView.tsx:644-889`, `packages/app-core/src/components/pages/AppsView.tsx:998-1120`).

AppDetails actions include Launch, launch destination radios, always-on-top checkbox, launch history recording, inline internal/overlay handling, desktop `desktopOpenAppWindow`, non-desktop `client.launchApp`, external URL open, widget Preview, and widget Show toggles (`packages/app-core/src/components/pages/AppDetailsView.tsx:293-427`, `packages/app-core/src/components/pages/AppDetailsView.tsx:494-620`, `packages/app-core/src/components/pages/AppDetailsView.tsx:720-748`).

Desktop-specific actions include detached surface windows, app windows, menu/tray app actions, route path validation, and always-on-top callbacks (`packages/app-core/platforms/electrobun/src/surface-windows.ts:141-180`, `packages/app-core/platforms/electrobun/src/surface-windows.ts:240-305`, `packages/app-core/platforms/electrobun/src/rpc-handlers.ts:57-63`, `packages/app-core/platforms/electrobun/src/rpc-handlers.ts:397-432`, `packages/app-core/platforms/electrobun/src/index.ts:1838-1854`, `packages/app-core/platforms/electrobun/src/index.ts:1938-1953`, `packages/app-core/platforms/electrobun/src/index.ts:2253-2273`).

Mobile deep links route to chat, phone, messages, contacts, LifeOps, settings, and connector-focus flows (`packages/app/src/main.tsx:420-465`). Native/cloud-hybrid mobile device bridge initialization is conditional on Capacitor native mode and runtime config (`packages/app/src/main.tsx:773-820`).

## Evidence reviewed with file refs

- App host config and bundled app imports: `packages/app/package.json:1-65`, `packages/app/app.config.ts:21-35`, `packages/app/capacitor.config.ts:4-50`, `packages/app/src/main.tsx:75-112`, `packages/app/src/main.tsx:250-290`.
- Main route inventory and platform gates: `packages/app-core/src/navigation/index.ts:32-90`, `packages/app-core/src/navigation/index.ts:115-129`, `packages/app-core/src/navigation/index.ts:175-262`, `packages/app-core/src/navigation/index.ts:289-360`, `packages/app-core/src/navigation/index.ts:410-430`, `packages/app-core/src/navigation/index.ts:433-489`.
- Main render branches: `packages/app-core/src/App.tsx:375-550`, `packages/app-core/src/App.tsx:835-885`, `packages/app-core/src/App.tsx:1168-1205`.
- Apps catalog, filters, and launch paths: `packages/app-core/src/components/apps/internal-tool-apps.ts:22-211`, `packages/app-core/src/components/apps/helpers.ts:43-90`, `packages/app-core/src/components/apps/helpers.ts:172-300`, `packages/app-core/src/components/apps/helpers.ts:317-360`, `packages/app-core/src/components/pages/AppsView.tsx:113-129`, `packages/app-core/src/components/pages/AppsView.tsx:426-497`, `packages/app-core/src/components/pages/AppsView.tsx:710-889`.
- App details and details-first decision logic: `packages/app-core/src/components/pages/AppDetailsView.tsx:82-127`, `packages/app-core/src/components/pages/AppDetailsView.tsx:293-427`, `packages/app-core/src/components/pages/AppDetailsView.tsx:494-620`, `packages/app-core/src/components/pages/AppDetailsView.tsx:777-800`.
- Overlay registry and Android-only platform contract: `packages/app-core/src/components/apps/overlay-app-registry.ts:31-75`, `packages/app-core/src/components/apps/catalog-loader.ts:13-45`, `packages/app-core/src/components/apps/overlay-app-api.ts:41-52`, `plugins/app-phone/src/components/phone-app.ts:14-26`, `plugins/app-contacts/src/components/contacts-app.ts:14-26`, `plugins/app-wifi/src/components/wifi-app.ts:14-26`.
- Desktop window shells and app-window renderer: `packages/app-core/src/platform/window-shell.ts:4-95`, `packages/app-core/src/shell/DetachedShellRoot.tsx:88-124`, `packages/app-core/src/shell/DetachedShellRoot.tsx:167-223`, `packages/app-core/src/shell/AppWindowRenderer.tsx:1-10`, `packages/app-core/src/shell/AppWindowRenderer.tsx:88-123`, `packages/app-core/src/shell/AppWindowRenderer.tsx:174-193`, `packages/app-core/src/shell/AppWindowRenderer.tsx:203-343`, `packages/app-core/src/shell/AppWindowRenderer.tsx:412-489`.
- Existing targeted tests: `packages/app-core/src/navigation/index.test.ts`, `packages/app-core/src/components/apps/catalog-coverage.test.ts`, `packages/app-core/src/components/apps/overlay-app-registry.test.ts`, `packages/app-core/test/components/apps/overlay-app-registry-android-only.test.ts`, `packages/app-core/src/components/pages/AppsView.test.tsx`, `packages/app-core/src/components/shell/Header.test.tsx`, `packages/app-core/platforms/electrobun/src/surface-windows.test.ts`, `packages/app-core/platforms/electrobun/src/application-menu.test.ts`.

## What I could validate

- Static route inventory: canonical tab paths, legacy path mappings, `/apps/<slug>` parsing, `/apps/<slug>/details`, and `/apps/*` sub-tab routing.
- Static render coverage: each canonical tab has an app-core render branch or an intentional fallback.
- Platform gates: phone/messages/contacts only render native phone pages when `isAndroidPhoneSurfaceEnabled()` returns true.
- Catalog merge/filter behavior: internal tools are injected, catalog apps and server apps are merged, duplicate names are deduped, and AppsView visibility is controlled by hidden/default/wallet/curated-game sets.
- Launch behavior from code: internal tools switch tabs on web, overlays set `activeOverlayApp`, details-page apps route to details first, catalog apps call `client.launchApp`, and Electrobun opens dedicated app windows first.
- Desktop route behavior from code and tests: detached surfaces and app windows are converted to renderer URLs; app windows use `?appWindow=1#/apps/<slug>`.
- Header/mobile button wiring from static review: main nav buttons call `setTab(primaryTab)`, mobile bottom nav mirrors tab groups, and chat mobile surface buttons switch only the chat sub-surface.

Targeted tests run:

```sh
bunx vitest run --config packages/app-core/vitest.config.ts \
  packages/app-core/src/navigation/index.test.ts \
  packages/app-core/src/components/apps/catalog-coverage.test.ts \
  packages/app-core/src/components/apps/overlay-app-registry.test.ts \
  packages/app-core/test/components/apps/overlay-app-registry-android-only.test.ts \
  packages/app-core/src/components/pages/AppsView.test.tsx \
  packages/app-core/src/components/shell/Header.test.tsx
```

Result: 6 test files passed, 46 tests passed.

```sh
bunx vitest run --config vitest.electrobun.config.ts \
  src/surface-windows.test.ts \
  src/application-menu.test.ts
```

Run from `packages/app-core/platforms/electrobun`. Result: 2 test files passed, 10 tests passed.

## What I could not validate

- I did not start a dev server or do exhaustive manual clicking. Scope was static review plus targeted tests.
- I did not verify live visual layout on actual browser/iOS/Android/Desktop builds, including safe-area, keyboard, window chrome, menu bar, tray, or high-DPI behavior.
- I did not validate native plugin permission prompts or device APIs for phone, messages, contacts, WiFi, push notifications, status bar, keyboard, mobile device bridge, or Android MiladyOS-only surfaces.
- I did not validate live cloud/catalog/runtime data, installed app availability, OAuth flows, wallet connectivity, trade execution, marketplace sessions, or remote game servers.
- I did not launch every app package. Many apps depend on runtime servers, catalog metadata, route loaders, viewer URLs, auth handshakes, or external URLs that require an end-to-end environment.
- I did not validate iframe/game postMessage auth with a real viewer. The static code path exists in `AppsView` and `AppWindowRenderer`, but real sessions still need live viewer checks.
- I did not validate desktop packaged app behavior. The Electrobun unit tests cover URL/menu/window-manager logic, not packaged app chrome, native focus, persistence, or crash recovery.

## Bugs/risks P0-P3

### P0

None found in this bounded review.

### P1

None found in this bounded review.

### P2

Android-only overlay filtering is inconsistent across catalog entry points. `loadMergedCatalogApps()` correctly uses `getAvailableOverlayApps()` to hide `androidOnly: true` apps off MiladyOS Android (`packages/app-core/src/components/apps/catalog-loader.ts:26-36`), but `AppsView.loadApps()` injects `getAllOverlayApps()` directly (`packages/app-core/src/components/pages/AppsView.tsx:466-470`), `AppDetailsView.resolveAppFromSlug()` resolves overlays from `getAllOverlayApps()` (`packages/app-core/src/components/pages/AppDetailsView.tsx:102-112`), and `AppWindowRenderer.resolveOverlayAppNameFromSlug()` does the same (`packages/app-core/src/shell/AppWindowRenderer.tsx:482-489`). The current `packages/app` host does not import Phone/Contacts/WiFi overlay registrations, so this may not be visible in the default elizaOS build. It is still a launch risk for white-label/native builds or future imports because direct catalog/details/app-window paths can bypass the availability filter.

Phone/messages/contacts routes and deep links are globally recognized but silently fall back to Chat outside native Android. The canonical route table includes `/phone`, `/messages`, and `/contacts` (`packages/app-core/src/navigation/index.ts:289-293`), deep links set those hash routes (`packages/app/src/main.tsx:446-455`), and the render branch returns ChatView when the Android phone surface gate is false (`packages/app-core/src/App.tsx:387-410`). That may be intended, but it needs explicit product sign-off and automated regression coverage because a user can land on `/phone` on web/iOS/desktop without seeing a not-available state.

Catalog/package inventory does not equal visible app inventory. Several packages exist in `apps/`, and some are bundled in `packages/app`, but AppsView filters hide system, utility, finance, and non-default games unless they are configured defaults, internal tools, wallet-scoped, or `VITE_PUBLIC_SHOW_ALL_APPS` is enabled (`packages/app-core/src/components/apps/helpers.ts:43-90`, `packages/app-core/src/components/apps/helpers.ts:172-231`). Human QA should not treat "package exists" as "tile should be visible." Launch QA for Hyperliquid and Polymarket especially depends on runtime/catalog availability because they are not imported by `packages/app/src/main.tsx:75-112` and are not listed in host dependencies next to the bundled apps (`packages/app/package.json:41-53`).

Details-first app launch can look like a failed first click if QA expects every app card to launch immediately. `AppsView.handleLaunch()` routes any app that `appNeedsDetailsPage()` returns true to `/apps/<slug>/details` instead of launching (`packages/app-core/src/components/pages/AppsView.tsx:714-725`). `appNeedsDetailsPage()` returns true for internal tools that opt in, apps with detail panels, apps with session metadata, and any app with `category === "game"` (`packages/app-core/src/components/pages/AppDetailsView.tsx:777-800`). Human scripts and Playwright smoke tests must click the details-page Launch button for those apps.

### P3

`/companion` has route/comment drift. `TAB_PATHS` still maps `companion` to `/companion` (`packages/app-core/src/navigation/index.ts:289-298`), while `LEGACY_PATHS` comments that `/companion` redirects to chat because Companion is now an overlay app (`packages/app-core/src/navigation/index.ts:353-355`). The render branch does return ChatView for `companion` (`packages/app-core/src/App.tsx:419-421`), so this is not a clear user-visible break, but the mapping/comment mismatch is easy to regress.

`tasks` has a path/tab mismatch. `TAB_PATHS` maps `tasks` to `/apps/tasks` (`packages/app-core/src/navigation/index.ts:294-296`), and `ViewRouter` still has a `tasks` branch that renders `TasksPageView` (`packages/app-core/src/App.tsx:433-438`), but `tabFromPath()` resolves `/apps/tasks` through `APPS_SUB_TABS` to `automations` (`packages/app-core/src/navigation/index.ts:410-414`, `packages/app-core/src/navigation/index.ts:465-469`). This may be intentional consolidation, but route smoke tests should lock the intended behavior.

Desktop app windows have good unit coverage for window URL construction and menu behavior, but not browser-level coverage of rendered content for critical app slugs. `AppWindowRenderer` has separate branches for internal tools, overlays, and registry apps (`packages/app-core/src/shell/AppWindowRenderer.tsx:412-459`); a Playwright smoke should load representative `?appWindow=1#/apps/<slug>` URLs with mocked catalog/runtime responses.

The button inventory is broad and shared across surfaces. Header buttons, mobile bottom nav, AppsView controls, AppDetails controls, desktop menu/tray actions, and native deep links all mutate route/app state through different paths. Existing tests cover important slices, but not a single end-to-end "route opens correct page and expected primary buttons exist" matrix for web/mobile/desktop.

## Codex-fixable work

- Use `getAvailableOverlayApps()` or an equivalent direct-route availability guard in `AppsView`, `AppDetailsView`, and `AppWindowRenderer`; add tests proving Android-only overlays stay hidden/unresolvable on web, iOS, desktop, and stock Android.
- Add a route inventory test that iterates `TAB_PATHS` and verifies every canonical tab either has a render branch, an explicit disabled-platform fallback, or a documented legacy redirect.
- Clarify whether `tasks` is a real page tab or a legacy alias for Automations, then align `TAB_PATHS`, `APPS_SUB_TABS`, and `ViewRouter` accordingly.
- Add AppsView tests for details-first launch behavior: game category, session metadata, internal details-page tools, overlay apps, and internal tools.
- Add mocked Playwright smoke coverage for `/chat`, `/apps`, `/apps/lifeops`, `/apps/plugins`, `/apps/skills`, `/apps/fine-tuning/details`, `/apps/companion`, `/apps/defense-of-the-agents/details`, `/connectors`, `/settings`, and mobile viewport bottom nav.
- Add Electrobun renderer smoke tests for representative `?appWindow=1#/apps/lifeops`, `?appWindow=1#/apps/plugins`, `?appWindow=1#/apps/companion`, and a mocked registry app iframe.
- Add a generated app inventory assertion that compares `packages/app/package.json`, `packages/app/src/main.tsx` side-effect imports, internal tool definitions, hidden app sets, and curated app ordering so launch QA can see drift before manual testing.
- Add explicit tests or docs for `/phone`, `/messages`, and `/contacts` fallback behavior on non-Android platforms.
- Add data-testid/aria coverage for AppDetails Launch, launch destination radios, widget Preview/Show, AppsView favorite/stop/pin controls, and desktop app-window controls where missing.

## Human click-through QA matrix

This matrix is intentionally targeted. It is meant to catch wiring, platform, permission, and visual regressions without exhaustive clicking of every secondary button.

| Area | Web | iOS | Android | Desktop | Human checks |
| --- | --- | --- | --- | --- | --- |
| Startup shell | `/chat`, root fallback | Native launch | Native launch | Main window launch | Auth/onboarding gates, connection banners, no blank shell. |
| Header navigation | Chat, Apps, Character, Connectors, Settings | Mobile bottom nav | Mobile bottom nav plus Android phone group if enabled | Desktop top nav, titlebar controls | Active state, focus, no clipped labels, correct route after click. |
| Mobile chat surfaces | Narrow viewport | Device | Device | N/A | Chats/Chat/Tasks & Events buttons switch panes and do not overlap safe area. |
| Apps hub | `/apps` | `/apps` | `/apps` | `/apps` | Browse/search/favorites/active filters, empty/error/loading states, visible tiles match expected gating. |
| Internal tool apps | LifeOps, Plugins, Skills, Fine Tuning, Trajectories, Relationships, Memories, Runtime, Database, Logs | Same where usable | Same where usable | Same plus app windows | Each tile opens the correct page or details page; back/return to Apps works. |
| Details-page launch | Fine Tuning, Steward, ElizaMaker, game apps | Same | Same | Dedicated window option | Details route loads, Launch button state works, destination radios/always-on-top behave as expected. |
| Overlay apps | Companion, Shopify, Vincent if visible | Companion if supported | Companion plus native overlays only if registered | Companion app window | Full-screen overlay covers shell, exit returns to Apps, no background interaction leak. |
| Game/catalog apps | Defense, ClawVille, Babylon, Scape, 2004Scape, Hyperscape as visible/configured | Same | Same | App window or game window | Details-first flow, viewer loads or error is useful, stop/reopen, iframe auth if required. |
| Finance/wallet apps | Steward, Vincent, Hyperliquid, Polymarket if available | Same | Same | Same | Requires wallet/cloud/account setup; verify hidden/visible rules and no accidental trading action. |
| Phone/messages/contacts | Should not show phone surfaces; direct route fallback/sign-off | Should not show phone surfaces unless product says otherwise | Native Android phone/messages/contacts | Should not show phone surfaces | Native permissions, empty states, incoming links, back behavior, direct `/phone` expectations. |
| WiFi/Contacts/Phone overlays | Hidden | Hidden | MiladyOS Android only | Hidden | Verify Android-only overlays do not appear on stock Android/iOS/web/desktop; verify native plugin prompts on MiladyOS. |
| Browser workspace | `/browser` when enabled | If enabled | If enabled | Main and detached browser window | URL entry, agent browser controls, detached browser `browse` seed on desktop. |
| Automations/workflows | `/automations`, `/apps/tasks` | Same | Same | Main and detached triggers window | Task creation/view, workflow builder route, legacy `/tasks` redirect. |
| Character and knowledge | `/character`, `/character/select`, `/character/documents` | Same | Same | Same | Character header actions, save/selection/knowledge page transitions. |
| Settings/deep links | `/settings`, `/settings/voice`, connector focus | Same | Same | Settings detached windows | Voice/cloud/connectors/permissions/update sections, deep link scroll/focus. |
| Desktop detached surfaces | N/A | N/A | N/A | chat, browser, release, triggers, plugins, connectors, cloud | Window singleton/focus, close/reopen, always-on-top where offered, renderer URL correctness. |
| Desktop app windows | N/A | N/A | N/A | internal, overlay, registry app | `?appWindow=1` windows render without main shell, iframe/external states, per-slug bounds, menu/tray actions. |
| Native mobile bridge | N/A | Cloud-hybrid/local modes | Cloud-hybrid/local modes | N/A | Device bridge connects only when configured; failure is non-blocking and visible in logs if needed. |

## Recommended automated coverage

- Route smoke unit: assert every canonical `TAB_PATHS` value resolves to the intended tab and every app-tool route in `APPS_SUB_TABS` resolves to the expected page.
- Platform gate unit: assert phone/messages/contacts nav groups and render branches across web, iOS, stock Android, and Android test flag contexts.
- Catalog visibility unit: assert hidden/system/default-hidden/wallet-scoped/featured app visibility with `showAllApps`, wallet enabled/disabled, configured defaults, and duplicate catalog/server app names.
- Overlay availability unit: assert Android-only overlays are unavailable not only in catalog-loader but also in AppsView, AppDetails, and AppWindowRenderer direct slug paths.
- Component tests: render `AppsView` with mocked `client.listApps`, `client.listCatalogApps`, `client.launchApp`, and overlay registry entries; verify details-first, internal tab, overlay, external URL, launch failure, stop, favorite, and pin flows.
- AppDetails component tests: verify Launch button, launch destination radios, always-on-top checkbox, widget Preview/Show, launch history, inline mode, and desktop bridge failure.
- Web Playwright smoke with mocked API: load the high-value routes listed in the human matrix and assert primary page landmarks/buttons exist for desktop and mobile viewport sizes.
- Desktop Playwright/Electrobun smoke: open detached surfaces and representative app windows; assert window title, renderer URL, and primary content.
- Native automation where feasible: Capacitor WebView smoke for safe-area/bottom-nav layout and Android phone route visibility with mocked native plugins.
- App package contract test: scan app package manifests and route/register files, then compare against curated catalog helpers and host imports to flag apps that exist but are neither hidden nor launchable.

## Changed paths

- `launchdocs/16-all-app-pages-qa.md`

## AI QA Pass 2026-05-11 (static analysis)

Workstream 1 of the AI QA master plan. Live screenshot/vision pass is blocked by the in-flight secrets refactor (`packages/core/src/features/index.ts` -> `manage-secret.ts`), so this pass reads each page component's source instead. Findings are tagged `[P0]` blocker / `[P1]` ship-stopper / `[P2]` should-fix / `[P3]` nice-to-have, capped at ~5 per route.

### Chat (`/chat`)

Component: `packages/ui/src/components/pages/ChatView.tsx` (1258 LOC). Inbox-chat subroute also lives here.

- [P2] `packages/ui/src/components/pages/ChatView.tsx:1230-1236` — `InboxChatPanel`'s `ChatComposer` wires five empty arrow handlers (`onAttachImage={() => {}}`, `onStop={() => {}}`, `onStopSpeaking={() => {}}`, `onToggleAgentVoice={() => {}}`, plus `hideAttachButton` only suppressing the attach button but not the other no-ops). The Stop / Stop Speaking / Toggle Voice buttons still render but do nothing. Fix: pass `undefined` and gate the corresponding buttons in `ChatComposer` so they hide rather than no-op.
- [P3] `packages/ui/src/components/pages/ChatView.tsx:866-868` — empty `catch {}` in `loadInboxMessages` silently swallows transient errors with no log, no surfacing, and no test. Fix: at minimum log to the structured logger; consider showing a banner after N consecutive failures so the user knows the inbox is stale.
- [P3] `packages/ui/src/components/pages/ChatView.tsx:1126` — `border border-border/35` plus inline `shadow-[0_10px_18px_-16px_rgba(15,23,42,0.45)]` literal in inbox avatar. Same rgba shadow recipe exists ~30x across the codebase. Fix: extract to a `shadow-card-sm` token in tailwind config.
- [P3] `packages/ui/src/components/pages/ChatView.tsx:619-622` — composer pad-bottom is `calc(var(--safe-area-bottom, 0px) + var(--eliza-mobile-nav-offset, 0px) + 0.375rem)` — correctly uses safe-area; this is a positive. Listed only to confirm the pattern.
- [P3] `packages/ui/src/components/pages/ChatView.tsx:556-557, 590-591` — `style={{ zIndex: 1 }}` inline literal repeated three times for share-ingest notice, dropped files row, voice latency row. Fix: pull to a class (`z-1` or `z-status-strip`) for consistency and so the magic value is named.

### Connectors (`/connectors`)

Component: `packages/ui/src/components/pages/ConnectorsPageView.tsx` (21 LOC) — a thin wrapper over `PluginsView` in `social` mode.

- [P3] `packages/ui/src/components/pages/PluginsView.tsx:162, 183` — `if (result?.loading) return testingLabel;` swallows the result object's `error` and `success` states when `loading` is true — fine for normal flow but if a stale `loading: true` is left in the store, the test pill is permanently stuck. Fix: assert `loading` clears on every fetch path or add a 60s safety timeout.
- No other findings for the route shell. (Audited `packages/ui/src/components/pages/ConnectorsPageView.tsx:1-21`.)

### Apps Catalog (`/apps`)

Components: `packages/ui/src/components/pages/AppsPageView.tsx` (89 LOC) and `packages/ui/src/components/pages/AppsView.tsx` (1194 LOC).

- [P1] `packages/ui/src/components/pages/AppsPageView.tsx:70-77` — hardcoded `#10b981` (Tailwind emerald-500) and matching rgba literals injected via inline `style` for the apps page's accent — design tokens should be section-scoped CSS vars, not raw hex. If the user runs a custom theme, the apps page will ignore it. Fix: define `--section-accent-apps` plus derived `--s-accent-glow` / `--s-accent-subtle` etc. in the theme stylesheet and reference them by name only, no fallback literals.
- [P2] `packages/ui/src/components/pages/AppsView.tsx:426-445` — `loadApps` catches any error and writes a translated error to local state, but the recovery affordance is implicit (page sits empty with a banner). Fix: show a "Retry" button in the error banner so the user can recover without navigating away.
- [P3] `packages/ui/src/components/pages/AppsView.tsx:464-466` — 5s polling interval (`setInterval(refresh, 5_000)`) runs even when the tab isn't visible. Fix: gate on `useDocumentVisibility()` to avoid waking the API loop in the background.
- [P3] `packages/ui/src/components/pages/AppsView.tsx:429, 459` — uses `console.warn` from the runtime client. Server-side rules require structured logger; client-side this is acceptable but consider `Logger` for consistency once a client logger exists.

### Automations (`/automations`)

Component: `packages/ui/src/components/pages/AutomationsFeed.tsx` (674 LOC).

- [P2] `packages/ui/src/components/pages/AutomationsFeed.tsx:405-407` — `onRunNow` catches `client.activateWorkflowDefinition` errors with `/* error surfaced on next refresh */` and silently swallows them. If the workflow can't activate (auth/quota/server), the user gets no feedback. Fix: set a banner state on catch with the error message instead of relying on the refresh side-effect.
- [P3] `packages/ui/src/components/pages/AutomationsFeed.tsx:437` — `hidden w-[360px] shrink-0 ... lg:block` — magic 360px chat pane width hardcoded. Fix: name it as a CSS var (`--automations-chat-width`) or tailwind extension to make it responsive-tunable.
- [P3] `packages/ui/src/components/pages/AutomationsFeed.tsx:284, 666` — `device-layout` + `max-w-5xl` / `max-w-7xl` shows three slightly different layout shells with subtly different max-widths in the same file. Fix: pick one shell and reuse.
- [P3] `packages/ui/src/components/pages/AutomationsFeed.tsx:331-345` — filter chips render `border-accent bg-accent/10` for active and `border-border/40` for inactive — good tokens. No fix needed; called out as a positive baseline.

### Browser Workspace (`/browser`)

Component: `packages/ui/src/components/pages/BrowserWorkspaceView.tsx` (2694 LOC — largest single page).

- [P1] `packages/ui/src/components/pages/BrowserWorkspaceView.tsx:1910-1942` — three install-bridge buttons (`InstallBrowserBridge`, `OpenBrowserBridgeFolder`, `OpenChromeExtensions`) share one `disabled={busyAction !== null}` state but have no aria-busy and no tooltip when disabled. A user clicking "Open Chrome extensions" while another action is in flight gets a silently disabled button with no explanation. Fix: add `aria-busy` and a `title` that explains "Another action is running" when disabled.
- [P2] `packages/ui/src/components/pages/BrowserWorkspaceView.tsx:2222-2289` — address bar disables on `selectedTabIsInternal` for "internal" tabs but the placeholder copy "Internal tab URL is managed by the app" is in the default fallback only — once translated, the explanation context can be lost. Fix: surface the explanation as a tooltip on the disabled state too.
- [P3] `packages/ui/src/components/pages/BrowserWorkspaceView.tsx:2354, 2412-2515` — repeated `disabled={busyAction !== null}` on at least six different `Button` elements. Single source of truth would be a `BusyButton` wrapper that handles aria-busy + disabled + spinner together; current pattern is repetitive.
- [P3] File length (2694 LOC) is itself a finding — single largest page in the audit. Fix: extract `BrowserBridgeSection`, `BrowserTabsSidebar`, and `BrowserAddressBar` into sibling files.

### Character Editor (`/character`)

Component: `packages/ui/src/components/character/CharacterEditor.tsx` (1488 LOC).

- [P1] `packages/ui/src/components/character/CharacterEditor.tsx:95-110, 113` — inline style objects with hardcoded fallback rgb `rgba(var(--accent-rgb, 240, 185, 11), 0.5)` etc. The fallback locks the default accent color to a specific golden hue (240,185,11). If `--accent-rgb` is unset the editor pretends to use the theme but actually paints in gold. Fix: drop the literal fallback in `rgba(var(...))` and let the css var system handle the cascade, or initialize `--accent-rgb` at the document root before this component mounts.
- [P2] `packages/ui/src/components/character/CharacterEditor.tsx:43-73` — inline SVG icon helpers (`DownloadIcon`, `UploadIcon`, etc.) defined with a comment "avoids adding lucide-react as a dependency", but lucide-react IS already imported across `LifeOpsPageView`, `Header`, etc. Fix: replace inline SVGs with `lucide-react` icons for consistency.
- [P3] `packages/ui/src/components/character/CharacterEditor.tsx:544` — `console.warn` for voice config load failure; client logger discussion same as Apps Catalog.
- [P3] Component is 1488 LOC — second largest page in the audit. Fix: panels (`CharacterIdentityPanel`, `CharacterStylePanel`, `CharacterExamplesPanel`) are already extracted; the remaining helper logic (handlers, draft management) could move to `useCharacterEditorState`.

### Character Knowledge (`/character/documents`)

Component: `packages/ui/src/components/pages/DocumentsView.tsx` (loaded via `CharacterEditor`'s documents page).

- [P2] `packages/ui/src/components/pages/DocumentsView.tsx:347, 661` — `console.error` for `[DocumentsView] Failed to load data` and `Failed to refresh after upload`. Acceptable on client, but neither surfaces a user-visible error banner; the page can silently fail to refresh after upload. Fix: set an `error` state on the catch path and render the existing error banner.
- [P2] `packages/ui/src/components/pages/DocumentsView.tsx:247` — `disabled={deleting || !doc.canDelete}` on delete control has no tooltip explaining why a doc isn't deletable. A user sees a grayed button with no reason. Fix: add `title={doc.canDelete ? "Delete" : "This document is protected"}`.
- [P3] `packages/ui/src/components/pages/DocumentsView.tsx:989-1000` — input uses `placeholder:text-muted/50` which on the design tokens resolves to extremely-low-contrast placeholder text. Fix: bump to `text-muted/60` or rely on the design system input component.

### Wallet / Inventory (`/wallet`)

Component: `plugins/app-wallet/src/InventoryView.tsx` (2419 LOC — largest page in the entire audit, exceeds BrowserWorkspaceView).

- [P1] `plugins/app-wallet/src/InventoryView.tsx:1` — file is 2419 LOC, with many embedded sub-components (`WalletRailAddress`, `WalletRailRpcButton`, `WalletRailAccount`, etc.). The monolith makes the page hard to test, hard to lazy-load, and hard to reason about. Fix: extract each `WalletRail*` and `Inventory*` sub-component into its own file under `plugins/app-wallet/src/inventory/`.
- [P2] `plugins/app-wallet/src/InventoryView.tsx:1318-1324` — `handleCopy` shows "Copied" for 1200ms via `setTimeout` but there's no cleanup on unmount; if the user clicks then navigates away inside 1.2s the unmounted-component state warning fires. Fix: cancel the timeout in a `useEffect` cleanup or use `useRef` with a `cancelled` flag.
- [P3] `plugins/app-wallet/src/InventoryView.tsx:1395-1406` — `WalletRailRpcButton` has `aria-label="Open RPC settings"` but no `aria-pressed` for the toggle-like indicator (green/yellow/red dot). Fix: convey RPC readiness via `aria-describedby` to a hidden status element.
- [P3] `plugins/app-wallet/src/InventoryView.tsx:1349-1352` — `cn("truncate font-mono text-xs", address ? "text-txt" : "text-muted")` — same pattern repeated for several status-toned spans. Could be a `WalletStatusText` component.

### Settings (`/settings`)

Component: `packages/ui/src/components/pages/SettingsView.tsx` (1234 LOC). Top-level shell only — sub-sections are covered by Workstream 6.

- [P2] `packages/ui/src/components/pages/SettingsView.tsx:531, 539` — export modal buttons use `min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)_+_2px)]` with a magic radius offset of `+ 2px`. Pattern is reused throughout settings dialogs. Fix: define `--radius-lg-plus` once or use a shared `<DialogButton>` wrapper.
- [P3] `packages/ui/src/components/pages/SettingsView.tsx:69-73, 84-103` — sidebar width localStorage keys + min/max/default constants live in this file. Fine for now but consider extracting to `settings-sidebar-prefs.ts` to share with the detached settings window code path.
- [P3] `packages/ui/src/components/pages/SettingsView.tsx:493` — `placeholder={t("settingsview.EnterExportPasswor")}` — the translation key is truncated (`EnterExportPasswor` instead of `EnterExportPassword`). Same defect appears for a few other i18n keys in this file. Fix: rename to full word; coordinate with i18n catalogs.
- [P3] No P0/P1 findings; settings shell layout itself is solid (uses `PageLayout` + `SidebarPanel` modern shell).

### App: lifeops (`/apps/lifeops`)

Component: `plugins/app-lifeops/src/components/LifeOpsPageView.tsx` (985 LOC).

- [P3] `plugins/app-lifeops/src/components/LifeOpsPageView.tsx:407-420` — `resolveLifeOpsChatPlaceholder` returns three different copy strings hand-rolled in English ("Ask about this reminder" / "Ask about this event" / "Ask about this message") rather than going through `t()`. Other strings in the file ARE translated. Fix: route through `t("lifeops.chat.placeholder.reminder", ...)` etc.
- [P3] `plugins/app-lifeops/src/components/LifeOpsPageView.tsx:78` — `LIFEOPS_COMPACT_LAYOUT_MEDIA_QUERY = "(max-width: 1023px)"` is a hardcoded breakpoint that doesn't match the tailwind `lg` breakpoint at `1024px`. Close enough to look like a bug. Fix: align with `tw.theme.screens.lg` so the JS-driven layout matches the CSS breakpoints exactly.
- No P0/P1 findings. Page uses `AppWorkspaceChrome` + `PagePanel` modern shell, surfaces a clear `EnablePrompt` empty state, and gates on Cloud presence.

### App: tasks (`/apps/tasks`)

Component: `packages/ui/src/components/pages/TasksPageView.tsx` (27 LOC) — but in current routing, `/apps/tasks` actually resolves to the automations shell (see existing P3 in this doc above).

- [P1] Existing finding (above in this doc): `/apps/tasks` and `TasksPageView` are wired through different routes. `TAB_PATHS` maps `tasks` to `/apps/tasks` and `ViewRouter` has a `tasks` branch rendering `TasksPageView`, but `tabFromPath('/apps/tasks')` resolves through `APPS_SUB_TABS` to `automations`. This means `TasksPageView` is dead code in the standard nav, AND the path-from-URL is automation-shaped — a P1 bug because the existing doc has flagged this and it's still unresolved. Fix: either delete `TasksPageView` and the `tasks` ViewRouter branch, or repoint `/apps/tasks` to render TasksPageView.
- [P3] `packages/ui/src/components/pages/TasksPageView.tsx:14-19` — `t("taskseventspanel.TasksViewDescription")` uses a different i18n namespace (`taskseventspanel.`) than every other page on this route (which use `taskseventspanel.Tasks` or similar). Confusing if/when this branch becomes live. Fix: align i18n keys.

### App: plugins (`/apps/plugins`)

Component: `packages/ui/src/components/pages/PluginsPageView.tsx` -> `PluginsView.tsx` -> `PluginCard.tsx`.

- [P2] `packages/ui/src/components/pages/PluginCard.tsx:240-241` — hardcoded literals `border-destructive bg-[rgba(153,27,27,0.04)] text-destructive` and `border-warn bg-[rgba(234,179,8,0.06)] text-warn`. Mixes design tokens (`text-destructive`, `text-warn`) with literal rgba bg colors. Fix: define `bg-destructive-tint-04` and `bg-warn-tint-06` tokens, or use `bg-destructive/4` (tailwind opacity) instead of raw rgba.
- [P3] `packages/ui/src/components/pages/PluginCard.tsx:426, 430` — HTML entities (`&#9881;` for gear, `&#9654;` for play) used instead of `lucide-react` icons that the rest of the codebase uses. Fix: replace with `<Settings />` / `<Play />` from lucide-react.
- [P3] `packages/ui/src/components/pages/PluginCard.tsx:436` — same `bg-[rgba(153,27,27,0.04)]` literal repeated. See P2 above.

### App: skills (`/apps/skills`)

Component: `packages/ui/src/components/pages/SkillsView.tsx` (uses `AppPageSidebar` modern shell).

- [P3] `packages/ui/src/components/pages/SkillsView.tsx:188-198` — primary "Create" button uses `text-xs-tight font-bold tracking-[0.12em]` — fine — but the rest of the file mixes `text-xs-tight font-semibold` in similar contexts. Inconsistent weight. Fix: pick one and apply consistently.
- [P3] `packages/ui/src/components/pages/SkillsView.tsx:401, 423` — placeholder copy `t("skillsview.eGMyAwesomeSkil")` and `t("skillsview.BriefDescriptionOf")` — the keys are truncated mid-word again (same i18n defect class as `SettingsView.tsx:493`). Fix: full-word keys.
- No P0/P1/P2 findings. Sidebar/main pattern, search, filter tabs, and empty states all present.

### App: fine-tuning (`/apps/fine-tuning`)

Component: `plugins/app-training/src/ui/FineTuningView.tsx` (697 LOC).

- [P3] `plugins/app-training/src/ui/FineTuningView.tsx:89-91` — `useState("http://localhost:11434")` — hardcoded default for the Ollama URL. If a user has Ollama on a different port (e.g. running multiple instances) they need to manually clear and re-type. Fix: read from `MILADY_OLLAMA_URL` or expose the default as a config var.
- [P3] `plugins/app-training/src/ui/FineTuningView.tsx:73-74` — `setBuildLimit("250")` / `setBuildMinCalls("1")` are stringified default numbers. Acceptable for `<Input type="text">` but visually mixes number/string semantics. Fix: keep as numbers and stringify only at render.
- No P0/P1/P2 findings. View uses `ContentLayout`, has loading/error/empty states, structured panels.

### App: trajectories (`/apps/trajectories`)

Component: `packages/ui/src/components/pages/TrajectoriesView.tsx`.

- [P2] `packages/ui/src/components/pages/TrajectoriesView.tsx:113-115` — `await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))` — bare exponential-backoff sleep inside a try-catch retry loop, with no abort signal. If the user navigates away during retry, the timer keeps running. Fix: pass an AbortSignal + clear the timer on cancel.
- [P3] `packages/ui/src/components/pages/TrajectoriesView.tsx:159-160` — `anchor.download = ... trajectories-${...split("T")[0]}.${format}` — filename includes only the date, not the time. Two exports in the same day will silently overwrite each other on download. Fix: include `HH-MM` suffix.
- [P3] `packages/ui/src/components/pages/TrajectoriesView.tsx:178-194` — selection-side-effect `useLayoutEffect` does a lot of conditional state mutation across `loading`, `trajectories`, `selectedTrajectoryId`. Hard to reason about. Fix: hoist to a `useTrajectorySelection` hook.

### App: relationships (`/apps/relationships`)

Component: `packages/ui/src/components/pages/RelationshipsView.tsx` (10 LOC stub) -> `packages/ui/src/components/pages/relationships/RelationshipsWorkspaceView.tsx` and `packages/ui/src/components/pages/RelationshipsGraphPanel.tsx`.

- [P2] `packages/ui/src/components/pages/RelationshipsGraphPanel.tsx:61-63` — color palette is hardcoded as `rgba(34, 197, 94, 0.64)` etc. for positive/neutral/negative. These should be `--tone-positive`, `--tone-neutral`, `--tone-negative` design tokens — the graph is unthemeable today. Fix: pull to CSS variables; this will also make dark-mode contrast tunable.
- [P3] `packages/ui/src/components/pages/RelationshipsGraphPanel.tsx:609-621, 671` — multiple `text-[rgba(99,102,241,0.86)]` / `text-[rgba(34,197,94,0.9)]` literals on `lucide-react` icons. Same as the palette finding — should be `text-tone-positive` etc.
- [P3] `packages/ui/src/components/pages/RelationshipsGraphPanel.tsx:1063-1073, 1145-1190` — SVG gradients use hardcoded `rgba(255,240,199,0.96)`, `rgba(199,210,255,0.98)` stops. These can't switch for dark mode and will look washed-out on a dark canvas. Fix: derive from `--accent`, `--tone-positive` etc.

### App: memories (`/apps/memories`)

Component: `packages/ui/src/components/pages/MemoryViewerView.tsx`.

- [P3] `packages/ui/src/components/pages/MemoryViewerView.tsx:355-356` — same low-contrast `placeholder:text-muted/50` pattern as DocumentsView. Fix: see Documents P3.
- [P3] `packages/ui/src/components/pages/MemoryViewerView.tsx:217-237` — loading/error/empty states present and idiomatic. No issue, called out as positive baseline.
- No P0/P1/P2 findings.

### App: runtime (`/apps/runtime`)

Component: `packages/ui/src/components/pages/RuntimeView.tsx` (uses `AppPageSidebar` modern shell).

- [P1] `packages/ui/src/components/pages/RuntimeView.tsx:502, 519, 536, 549-550, 562, 686` — at least six places where an 800+ character inline `className` string is duplicated verbatim. Each combines `bg-[linear-gradient(...)]`, `shadow-[inset_0_1px_0_rgba(255,255,255,0.14),...]`, hover/focus/disabled variants. Total > 5KB of duplicated className per render. Fix: extract to a single `RUNTIME_INPUT_CLASS` and `RUNTIME_BUTTON_CLASS` constant, or use `cva()` / `clsx()` with named variants. This file alone has the worst Tailwind duplication in the codebase.
- [P2] `packages/ui/src/components/pages/RuntimeView.tsx:497-501` — `Math.max(1, Math.min(24, Number(event.target.value) || 1))` — number-coercion logic repeated three times for depth/array-cap/object-cap inputs. Fix: extract `clampInputNumber(min, max)` helper.
- [P3] `packages/ui/src/components/pages/RuntimeView.tsx:506, 523` — `{/* biome-ignore lint/a11y/noLabelWithoutControl: programmatic control association is preserved */}` — three suppressions. Verify the association is actually preserved (htmlFor + id) or restructure to use `<Label htmlFor>` from `@elizaos/ui`.

### App: database (`/apps/database`)

Component: `packages/ui/src/components/pages/DatabaseView.tsx`.

- [P1] `packages/ui/src/components/pages/DatabaseView.tsx:282, 410, 866, 893` — same multi-hundred-character duplicated `className` strings as RuntimeView. The `linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))` recipe repeats verbatim 4+ times. Fix: same as RuntimeView P1 — extract to a constant or `cva`.
- [P2] `packages/ui/src/components/pages/DatabaseView.tsx:622` — error banner uses inline `shadow-[0_0_15px_rgba(231,76,60,0.15)]` literal — that's a hardcoded danger-red shadow, not a token. Fix: use `shadow-danger-glow` token.
- [P2] `packages/ui/src/components/pages/DatabaseView.tsx:630` — close-button copy is the literal `×` character. On screen readers this announces as "multiplication sign x". Fix: wrap in `<span aria-hidden="true">×</span>` and add an explicit `aria-label` (already on the Button but verify — current is `aria-label`-less `Button variant="ghost"`).
- [P3] `packages/ui/src/components/pages/DatabaseView.tsx:254` — `bg-ok shadow-[0_0_8px_rgba(34,197,94,0.5)]` — same green shadow-glow pattern; should be a token.

### App: logs (`/apps/logs`)

Component: `packages/ui/src/components/pages/LogsView.tsx`.

- [P2] `packages/ui/src/components/pages/LogsView.tsx:268-278` — log-level color logic uses a ternary chain `entry.level === "error" ? "text-danger" : entry.level === "warn" ? "text-warning" : ...`. Note: `text-warning` is used here, but elsewhere the file uses `text-warn`. Inconsistent token name. Fix: pick one (`text-warn` is the project standard) and update.
- [P2] `packages/ui/src/components/pages/LogsView.tsx:294-311` — log tag color palette is hardcoded as an inline `Record<string, string>` object literal inside `.map()`. Allocates a new object every render and every iteration. Fix: hoist to a `LOG_TAG_TONES` constant outside the component.
- [P3] `packages/ui/src/components/pages/LogsView.tsx:313` — `style={{ fontFamily: "var(--font-body, sans-serif)" }}` inline style. If `--font-body` is set globally, this is redundant; if it's not, the fallback is `sans-serif` which inherits the OS default and won't match design. Fix: rely on `font-body` tailwind class.
- [P3] `packages/ui/src/components/pages/LogsView.tsx:215` — `border-danger/35 bg-danger/8` — `bg-danger/8` is `8%` opacity, which is a non-standard tailwind opacity step. Verify the tailwind config exposes `/8` or this silently no-ops. Fix: use `/5` or `/10`.

### App: companion (`/apps/companion`)

Component: `plugins/app-companion/src/components/companion/CompanionShell.tsx` (62 LOC) -> `CompanionView.tsx`.

- [P2] `plugins/app-companion/src/components/companion/CompanionShell.tsx:57` — `h-[100vh]` plus `supports-[height:100dvh]:h-[100dvh]` fallback. On iOS Safari < 15.4, `100dvh` isn't supported, so the chat composer can be hidden behind the URL bar. Fix: add an explicit safe-area inset; already correctly handled by the `100dvh` part, just verify on the iOS target.
- [P3] `plugins/app-companion/src/components/companion/CompanionShell.tsx:33-46` — VRM prefetch on mount only — if a user adds a custom VRM mid-session, the new asset isn't preloaded. Fix: re-trigger prefetch when `getVrmCount()` changes.
- [P3] `plugins/app-companion/src/components/companion/CompanionShell.tsx:24` — comment "swallowed by VrmEngine" — verify that's actually true (P3 because no evidence of swallow).

### App: shopify (`/apps/shopify`)

Component: `plugins/app-shopify/src/ShopifyAppView.tsx` (442 LOC).

- [P1] `plugins/app-shopify/src/ShopifyAppView.tsx:174` — `className="fixed inset-0 z-50 ..."` — full-screen overlay with `fixed inset-0` does NOT include `pt-safe` / `pb-safe` / `env(safe-area-inset-*)`. On iPhone with a notch the header is partially under the notch; on iPhone with home-bar gesture, the back button is partially under the indicator. Fix: add `pt-safe pb-safe` or equivalent CSS env-inset.
- [P2] `plugins/app-shopify/src/ShopifyAppView.tsx:223-230` — `ShopifySetupCard` shows env var names (`SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`) directly as the setup instructions. This is power-user friendly but a non-dev user gets no actionable next step. Fix: provide a "Configure in Settings" link / button next to the env block, or auto-detect and prefill via the Secrets manager.
- [P3] `plugins/app-shopify/src/ShopifyAppView.tsx:30-89` — `ShopifySetupCard` is a sibling component in the same file with no `data-testid`. Tests can find the shell but not the empty state. Fix: add `data-testid="shopify-setup-card"`.

### App: vincent (`/apps/vincent`)

Component: `plugins/app-vincent/src/VincentAppView.tsx` (158 LOC).

- [P1] `plugins/app-vincent/src/VincentAppView.tsx:40` — `className="fixed inset-0 z-50 flex flex-col bg-bg h-[100vh] overflow-hidden supports-[height:100dvh]:h-[100dvh]"` — same safe-area defect as ShopifyAppView. Fix: same.
- [P2] `plugins/app-vincent/src/VincentAppView.tsx:122-137` — empty state ("Connect your Vincent account to get started") shows static text but no actual connect button below the prompt. The connect button lives in `VincentConnectionCard` ABOVE the prompt, which is non-obvious — user reads "to get started" and then has to scroll up. Fix: re-order so the message is above the connect card, or add a "Scroll to connect ↑" hint.
- [P3] `plugins/app-vincent/src/VincentAppView.tsx:123` — `bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_98%,transparent))]` — same recipe as RuntimeView/DatabaseView. Hoist.

---

### Summary

- **P0:** 0
- **P1:** 8 — Apps Catalog hex literal (`AppsPageView.tsx:70-77`); Browser Workspace disabled-button aria gaps (`BrowserWorkspaceView.tsx:1910-1942`); Character editor accent-rgb fallback (`CharacterEditor.tsx:95-110`); Wallet inventory 2419-LOC monolith (`InventoryView.tsx:1`); `/apps/tasks` route misalignment (existing P3 promoted, see `TasksPageView.tsx` + `navigation/index.ts:410`); RuntimeView duplicated 800+char className strings (`RuntimeView.tsx:502+`); DatabaseView same (`DatabaseView.tsx:282+`); Shopify and Vincent missing safe-area inset (`ShopifyAppView.tsx:174` + `VincentAppView.tsx:40`).
- **P2:** ~13 — error swallows in chat inbox/automations/documents, hardcoded relationship palette (`RelationshipsGraphPanel.tsx:61-63`), hardcoded plugin-card rgba (`PluginCard.tsx:240-241`), trajectory retry timer leak, log inconsistent tone names (`LogsView.tsx:268`), Shopify env-only setup, Vincent empty-state ordering, etc.
- **P3:** ~25 — i18n key truncations, inline icon/SVG inconsistency, magic widths, redundant `console.warn`s, polling without visibility gating.

**Top-3 most concerning findings:**
1. `packages/ui/src/components/pages/RuntimeView.tsx:502, 519, 536, 549-550, 562, 686` — six+ repetitions of identical 800-character Tailwind className strings. Same pattern repeats in DatabaseView. This is the worst tailwind duplication in the audit and a strong signal the design-token + variant strategy isn't being applied. Fix would eliminate ~5KB of duplicated string per render in just RuntimeView, plus enable theme-color refactors elsewhere.
2. `plugins/app-shopify/src/ShopifyAppView.tsx:174` and `plugins/app-vincent/src/VincentAppView.tsx:40` — full-screen overlay apps using `fixed inset-0` without safe-area insets. Both apps will visibly clip their headers and back buttons on iPhones with notches or home indicators. Mobile-first feature regressing.
3. `plugins/app-wallet/src/InventoryView.tsx` — 2419 LOC single file. Beyond a P1 maintainability finding, this file's size strongly correlates with how often it ships regressions; extracting `WalletRail*` and `Inventory*` subtrees would unblock per-section testing.
