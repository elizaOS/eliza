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
