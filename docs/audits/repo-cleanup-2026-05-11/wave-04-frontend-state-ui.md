# Wave 4 Dry Run - Frontend State and UI

Date: 2026-05-11

Worker scope: frontend/UI design slop, `AppContext` and state hierarchy,
refresh/reload behavior, overlarge React components/controllers, CSS/design
clutter, and API/client seams.

Dry-run rule: no source, config, test, asset, package, route, or generated file
changes are proposed as already-approved work. This report is the only file
created in Wave 4.

## Executive Summary

The frontend has already started extracting state from the original monolithic
`AppContext`, but the compatibility surface is still effectively the whole app:
`AppState & AppActions` remains a thousand-line type contract and
`AppProviderInner` still composes every major runtime, chat, plugin, wallet,
cloud, onboarding, and page concern into one memoized object. The highest-value
cleanup is not deleting UI. It is finishing the state boundary split while
preserving `useApp()` as a temporary facade.

The biggest component/controller hotspots are:

- `packages/ui/src/components/pages/BrowserWorkspaceView.tsx`
- `packages/ui/src/components/shell/RuntimeGate.tsx`
- `packages/ui/src/components/apps/GameView.tsx`
- `plugins/app-lifeops/src/components/LifeOpsWorkspaceView.tsx`
- `plugins/app-lifeops/src/components/LifeOpsPageView.tsx`
- `packages/ui/src/components/config-ui/config-field.tsx`
- `packages/ui/src/components/config-ui/ui-renderer.tsx`

The highest-risk behavior cluster is refresh/reload. Some surfaces use hard
reloads, others poll independently, and browser workspace has several manual
native-webview synchronization loops. Cleanup must first centralize resource
ownership and cancellation, then replace full reloads only where equivalent
state resets exist.

## Current Inventory

### State Hierarchy

| File / symbol | Current role | Dry-run disposition |
| --- | --- | --- |
| `packages/ui/src/state/types.ts:309` `AppState` | Global state type for runtime, chat, triggers, plugins, wallet, cloud, onboarding, UI shell, game, MCP, and config text. | Keep as compatibility type initially. Split into narrower domain types and make new code consume domain contexts/selectors. |
| `packages/ui/src/state/types.ts:734` `AppActions` | Global action surface for navigation, lifecycle, chat, plugins, skills, logs, wallet, registry, character, onboarding, cloud, Vincent, updates, workbench, export/import. | Keep as compatibility type while extracting action owners. Mark fields by future owner in a migration note before moving code. |
| `packages/ui/src/state/types.ts:1003` `AppContextValue` | `AppState & AppActions`. | Replace internally with composed providers; export facade only for legacy callers. |
| `packages/ui/src/state/AppContext.tsx:201` `AppProviderInner` | Single root composition point for almost every state hook. | Split provider tree by domain. Keep `AppProvider` as public wrapper. |
| `packages/ui/src/state/AppContext.tsx:1309` `setState` | Generic setter map from string keys to domain setters. | Freeze for compatibility; do not add new fields. Replace call sites with domain actions as they are migrated. |
| `packages/ui/src/state/AppContext.tsx:1860` `value` | Giant memoized `AppContextValue`; still includes high-churn fields such as messages/events despite comments excluding some. | Shrink by moving volatile data to domain contexts, then create a stable facade object from selectors. |
| `packages/ui/src/state/ChatComposerContext.tsx` | Already isolates `chatInput`, `chatSending`, `chatPendingImages`. | Keep. Use as pattern for other high-churn state. |
| `packages/ui/src/state/PtySessionsContext.tsx` | Already isolates PTY session polling from `AppContext`. | Keep. Expand same approach to browser workspace and LifeOps polling. |
| `packages/ui/src/components/workspace/AppWorkspaceChrome.tsx:257` `AppWorkspaceChrome` | Owns page chrome, right chat rail collapse state, mobile pane switching, persisted chat width. | Keep, but move pane persistence and mobile pane state into a reusable workspace-layout hook. |
| `packages/ui/src/components/pages/PageScopedChatPane.tsx:151` `PageScopedChatPane` | Owns page-scoped assistant conversation state. | Keep. It is a good boundary, but should not need the whole `useApp()` surface. |

### Refresh and Reload

| File / symbol | Current behavior | Cleanup target |
| --- | --- | --- |
| `packages/ui/src/onboarding/reload-into-runtime-picker.ts:29` `reloadIntoRuntimePicker` | Clears persisted runtime selection, appends `?runtime=picker`, then assigns `window.location.href`. | Keep until a runtime reset action exists. Later replace with coordinator reset + route state to avoid full renderer reload. |
| `packages/ui/src/components/settings/RuntimeSettingsSection.tsx:123` `handleSwitch` | Calls `reloadIntoRuntimePicker`. | Keep in Wave 4 implementation until RuntimeGate owns a non-reload transition. |
| `packages/ui/src/components/shell/RuntimeGate.tsx:397` `RuntimeGate` | Runtime picker, cloud provisioning, remote/local selection, startup routing. | Extract flow reducers and API orchestration before changing reload behavior. |
| `packages/ui/src/components/pages/BrowserWorkspaceView.tsx:690` `loadWorkspace` | Fetches browser workspace snapshot and selected tab, called on mount and every 2.5s. | Move to `useBrowserWorkspaceResource` with cancellation, backoff, and event-driven refresh hooks. |
| `packages/ui/src/components/pages/BrowserWorkspaceView.tsx:1697` interval | Polls workspace every `POLL_INTERVAL_MS` while visible. | Keep behavior; centralize with other workspace timers. |
| `packages/ui/src/components/pages/BrowserWorkspaceView.tsx:1709` interval | Polls selected cloud/session snapshot. | Centralize and gate by mode + selected tab. |
| `packages/ui/src/components/pages/BrowserWorkspaceView.tsx:1720` interval | Polls wallet state every 5s. | Move to wallet/browser bridge state boundary; pause when wallet sheet or tab is hidden. |
| `packages/ui/src/components/pages/BrowserWorkspaceView.tsx:1724` interval | Polls Agent Browser Bridge every 4s. | Back off when bridge unsupported or package missing. |
| `packages/ui/src/components/pages/BrowserWorkspaceView.tsx:1789` `reloadSelectedBrowserWorkspaceTab` | Reloads iframe/webview or navigates the selected tab. | Keep semantics; expose through a tab controller and test web + desktop modes. |
| `packages/ui/src/components/pages/BrowserWorkspaceView.tsx:1927` `refreshBrowserBridgeConnection` | Manual bridge refresh with action notice. | Move into bridge resource hook. |
| `plugins/app-lifeops/src/hooks/useLifeOpsAppState.ts:10` `useLifeOpsAppState` | Loads LifeOps enabled state in effect and exposes separate `refresh`. | Keep behavior but share a reusable resource pattern with cancellation and stale snapshots. |
| `plugins/app-lifeops/src/hooks/useGoogleLifeOpsConnector.ts:515` `useGoogleLifeOpsConnector` | Polls connector status, handles app resume, storage/channel refresh fanout. | Treat as connector resource owner; avoid duplicate polling from page components. |
| `plugins/app-lifeops/src/components/LifeOpsWorkspaceView.tsx:393` `load` | Loads calendar + Gmail workspace data. | Extract calendar/Gmail workspace resource hooks. |
| `plugins/app-lifeops/src/components/LifeOpsWorkspaceView.tsx:543` `refresh` | Refreshes connector and workspace with force sync. | Keep API behavior; make the UI refresh button call one orchestrated refresh path. |
| `plugins/app-lifeops/src/components/LifeOpsOverviewSection.tsx:1016` `refresh` | Fanout refreshes overview, screen time, social, weekly, capabilities, Google, X, calendar, messages, mail. | Replace fanout in component with `useLifeOpsOverviewResources().refreshAll()`. |
| `cloud/apps/frontend/src/components/agents/agent-card.tsx:217` / `:244` | Deletes an agent or saved agent, dispatches `characters-updated`, then calls `window.location.reload()`. | Replace with data invalidation or parent state update in cloud app cleanup; verify this separately from desktop `packages/ui`. |

### Overlarge Components and Controllers

| File / symbol | Size / smell | Proposed decomposition |
| --- | --- | --- |
| `packages/ui/src/components/pages/BrowserWorkspaceView.tsx:412` `BrowserWorkspaceView` | 2,753 lines; mixes tab state, wallet RPC, vault autofill, bridge package install, OOPIF masking, polling, sidebar, toolbar, iframe/webview render. | Split into `useBrowserWorkspaceResource`, `useBrowserBridgeResource`, `useBrowserWalletRequests`, `useVaultAutofillRequests`, `useElectrobunWebviewRegistry`, `BrowserTabRail`, `BrowserToolbar`, `BrowserSurface`. |
| `packages/ui/src/components/shell/RuntimeGate.tsx:397` `RuntimeGate` | 2,370 lines; runtime choice UI, cloud provisioning, URL parsing, local/remote handoff, errors. | Split flow state/reducer, runtime card UI, cloud provisioning controller, and URL target helpers. |
| `packages/ui/src/components/apps/GameView.tsx` | 2,175 lines; app session UI plus viewer control logic. | Split session controller, postMessage bridge, viewer shell, and details/sidebar components. |
| `plugins/app-lifeops/src/components/LifeOpsWorkspaceView.tsx` | 2,004 lines; Google connector, calendar, Gmail search/recommendations/replies/bulk manage/event compose. | Split Google account status, CalendarWorkspace, GmailWorkspace, GmailReplyDrawer, CalendarEventComposer. |
| `plugins/app-lifeops/src/components/LifeOpsPageView.tsx:443` onward | LifeOps enablement, GitHub OAuth, section routing, settings mapping, page shell. | Split GitHub setup controller, enable gate, page shell composition. |
| `packages/ui/src/components/config-ui/config-field.tsx` | 1,997 lines; many field types and layout variants. | Split field registry by type, shared label/help/error chrome, and value adapters. |
| `packages/ui/src/components/config-ui/ui-renderer.tsx` | 1,775 lines; schema renderer + layout. | Split schema traversal from render components. |
| `packages/ui/src/components/character/CharacterEditor.tsx` | 1,488 lines; edit form, tab content, validation, model/voice/avatar controls. | Move character draft mutations to hook; split each tab panel. |
| `packages/ui/src/components/pages/PluginsView.tsx` and `plugin-view-connectors.tsx` | Plugin list, filters, connector status, settings, marketplace-like actions. | Share data/resource hooks with `usePluginsSkillsState`; reduce useApp dependencies. |

### Design and CSS Clutter

| File / selector | Current issue | Cleanup target |
| --- | --- | --- |
| `packages/ui/src/styles/base.css:3` and `packages/ui/src/styles/theme.css:1` | Duplicate theme token roots with overlapping variables. | Decide canonical source. `theme.css` looks redundant unless used by package consumers separately. |
| `packages/ui/src/styles/styles.css:28-30` `@source` | Tailwind source includes `packages/ui` and `plugins/app-lifeops` from core UI stylesheet. | Move plugin-specific source registration to app build config or plugin stylesheet registration if possible. |
| `packages/ui/src/styles/styles.css:290` global scrollbar selectors | Applies custom scrollbar to `*`, every scrollbar, all components. | Scope to `.custom-scrollbar`, shell scroll regions, and chat transcript surfaces; verify native/electrobun webviews are unaffected. |
| `packages/ui/src/styles/brand-gold.css:1` / `:113` | Brand variables and onboarding variables share one brand file. | Split brand token overrides from onboarding-specific visual language. |
| `packages/ui/src/styles/brand-gold.css:288` `.settings-content-area` | Large page-specific global override block, including class substring selectors. | Replace with component classes or tokens applied in Settings shell. |
| `packages/ui/src/styles/brand-gold.css:349-359` substring class selectors | Overrides Tailwind utility class fragments such as `bg-card/40`. | Remove after Settings components use explicit semantic classes. |
| `packages/ui/src/styles/brand-gold.css:385` `.plugins-game-card` | Plugin/game card styling lives in brand stylesheet. | Move to page/component stylesheet or Tailwind component classes. |
| `packages/ui/src/styles/brand-gold.css:550` `.logs-toolbar-button` | Logs page button styling lives in brand stylesheet. | Move to shared button variant or Logs component style token. |
| `packages/ui/src/components/pages/DatabaseView.tsx` | Many long arbitrary gradient/shadow class strings and rounded-2xl/3xl panels. | Normalize to shared table/sidebar/panel components. |
| `packages/ui/src/components/pages/VectorBrowserView.tsx` | Inline style reads CSS variables and uses several rounded-2xl/3xl empty states. | Keep canvas-specific color reads; move empty states/filter buttons to shared primitives. |
| `plugins/app-companion/src/components/companion/shell-control-styles.ts` | Very long arbitrary Tailwind class constants with gradients, shadows, backdrop blur. | Replace with named component classes or shared shell-control primitive. |
| `plugins/app-companion/src/components/companion/VrmStage.tsx` | Inline radial/linear background strings and hard-coded colors. | Keep 3D/full-bleed behavior, but move palette to tokens; verify no blank 3D scene after changes. |

### API and Client Seams

| File / symbol | Current issue | Cleanup target |
| --- | --- | --- |
| `packages/ui/src/api/client-base.ts:133` `ElizaClient` | Mutable singleton state, REST, WebSocket, base URL persistence, auth token, transport selection, SSE parsing all in one class. | Keep public singleton. Extract transport/session/websocket responsibilities behind internal collaborators. |
| `packages/ui/src/api/client-base.ts:486` `fetch<T>` | Generic JSON fetch with timeout/error parsing. | Keep; do not duplicate. New domain clients should call this or a typed wrapper. |
| `packages/ui/src/api/client-base.ts:527` `connectWs` | WebSocket lifecycle and reconnect state mixed into REST client. | Move to `RealtimeClient` owned by `ElizaClient` or a runtime session provider. |
| `packages/ui/src/api/csrf-client.ts:44` `fetchWithCsrf` | Separate fetch helper duplicates transport selection and token attachment behavior for dashboard routes. | Decide seam: either route all dashboard calls through `ElizaClient.rawRequest` or make `fetchWithCsrf` share a common transport/auth utility. |
| `packages/ui/src/api/client.ts` side-effect imports | Domain methods are added via declaration merging and prototype augmentation. | Keep for backward compatibility; freeze new prototype additions. New code should prefer domain modules exporting typed functions that accept a client. |
| `packages/ui/src/api/client-agent.ts:385` `interface ElizaClient` | Very broad augmentation: lifecycle, auth, config, connectors, triggers, training, plugins, logs, security, relationships, character, permissions, stream, accounts. | Split by domain file and route ownership. `client-agent.ts` should become a barrel of narrower augmentations or adapters. |
| `packages/ui/src/api/client-chat.ts:122` `interface ElizaClient` | Chat, inbox, documents, memory, MCP, workbench share one augmentation. | Split chat/inbox/documents/memory/MCP/workbench clients. |
| `plugins/app-lifeops/src/api/client-lifeops.ts:205` `LifeOpsElizaClientMethods` | Plugin augments `@elizaos/ui` client with large LifeOps API surface. | Keep plugin registration, but consider a plugin-owned `lifeOpsClient(client)` adapter so app-core does not need plugin method shape in core state. |
| `plugins/plugin-social-alpha/src/frontend/index.tsx:71` `queryClient` | This plugin uses TanStack Query independently. | Do not introduce repo-wide Query casually; use as evidence for a possible resource-cache pattern only after dependency/ownership review. |

## Proposed State Boundaries

The target architecture should preserve `AppProvider` as the external wrapper
while replacing the single `AppContextValue` with composed domain providers.
`useApp()` remains as a compatibility facade until call sites are migrated.

1. Runtime Session

Owner files: `useLifecycleState`, `useStartupCoordinator`,
`useAppLifecycleEvents`, `client-base` WebSocket connection state.

State/actions:

- `connected`, `agentStatus`, `startupCoordinator`, `startupPhase`,
  `startupError`, `authRequired`, `backendConnection`, system warnings.
- `handleStart`, `handleStop`, `handleRestart`, `handleReset`,
  `retryStartup`, `restartBackend`, `relaunchDesktop`,
  `retryBackendConnection`.

Boundary rule: runtime session owns process/backend state only. It should not
own chat thread selection, plugin filters, wallet inventory, or onboarding form
fields.

2. Navigation and Shell

Owner files: `useNavigationState`, `useAppShellState`, `App.tsx`,
`AppWorkspaceChrome`.

State/actions:

- `tab`, `uiShellMode`, `navigation`, `activeOverlayApp`,
  `activeGameRunId`, `gameOverlayEnabled`, shell sub-tabs, mobile workspace
  panes.

Boundary rule: URL/hash changes and shell view routing live here. Page filters
should move to URL/search params or page-local state, not global `AppContext`.

3. Chat Threads

Owner files: `useChatState`, `useChatCallbacks`, `ChatComposerContext`,
`PtySessionsContext`, `ChatView`, `PageScopedChatPane`.

State/actions:

- Conversations, active conversation id, messages, unread set, companion
  cutoff, active inbox chat, active terminal session id.
- Composer remains in `ChatComposerContext`.
- PTY sessions remain in `PtySessionsContext`.

Boundary rule: typing and PTY polling must not re-render shell, settings,
browser workspace, or companion scene. `ChatView` should depend on chat domain
hooks, not full `useApp()`.

4. App Catalog, Plugins, Skills, Store

Owner files: `usePluginsSkillsState`, `PluginsView`, `SkillsView`,
`AppsPageView`, `ElizaOsAppsView`.

State/actions:

- Installed plugin list, plugin config/save state, skills list, skill
  marketplace state, store/catalog filters.

Boundary rule: plugin filters and marketplace search are page-local or
plugin-domain state. Runtime restart banner reasons can be emitted to Runtime
Session through an event/action, not by passing many setters into the hook.

5. Character and Profile

Owner files: `useCharacterState`, `CharacterEditor`, `CharacterHubView`,
`agent-profiles`.

State/actions:

- Character draft/data, VRM selection and custom URLs, content pack selection,
  active agent profile.

Boundary rule: `selectedVrmIndex` and visual companion config can be exposed via
`CompanionSceneConfigContext`; character editor form state should not live in
the app-wide facade after migration.

6. Cloud and Wallet

Owner files: `useCloudState`, `useWalletState`, wallet pages, cloud dashboard.

State/actions:

- Cloud auth/credits/dashboard status.
- Wallet addresses/config/balances/NFTs/inventory/registry/drop/steward.

Boundary rule: split cloud auth/credits from wallet inventory. Browser wallet
requests should consume a wallet read model, not the whole app context.

7. Onboarding and Runtime Picker

Owner files: `useOnboardingState`, `useOnboardingCallbacks`,
`RuntimeGate`, `reload-into-runtime-picker`.

State/actions:

- Runtime target, provider/API keys, onboarding feature toggles, deferred tasks,
  completion.

Boundary rule: keep old fields in `useApp()` until Settings/RuntimeGate migrate,
but new runtime switching should go through a reducer action rather than a
full-page navigation.

8. Notifications and Dialogs

Owner files: `action-notice`, `useConfirm`, `usePrompt`, `ShellOverlays`.

State/actions:

- `actionNotice`, confirm/prompt modal roots, once-only notices.

Boundary rule: domain hooks can emit notices through a small notification
interface. They should not require all lifecycle setters.

## Proposed Cleanup Work Packages

### W4-A: Context Boundary Freeze

Goal: stop `AppContext` from growing while preserving compatibility.

Checklist:

- Add an internal comment map in `AppContext.tsx` grouping every `value` field
  by target provider.
- Mark `setState` as compatibility-only and reject new keys in review.
- Migrate low-risk consumers first: settings labels that only need `t`, simple
  button actions that only need `setActionNotice`, and page-local filters.
- Add render-count instrumentation in development for `App`, `Header`,
  `CompanionSceneHost`, `ChatView`, and `AppWorkspaceChrome` before and after
  context splits.

Validation:

- Typing in chat does not re-render `Header`, Settings, BrowserWorkspace, or
  Companion shell.
- PTY poll updates do not re-render non-terminal pages.
- Startup, reset, and runtime picker still reach the same persisted state.

### W4-B: Browser Workspace Decomposition

Goal: split a 2,753-line controller into testable resource and platform pieces
without changing behavior.

Proposed modules:

- `useBrowserWorkspaceResource`: `workspace`, `selectedTabId`, tab open/show/
  hide/close/navigate/reload, initial `?browse=` handling, polling.
- `useBrowserBridgeResource`: bridge supported/available/loading,
  companion/package status, install/reveal/open-manager/refresh actions.
- `useBrowserWalletRequests`: EVM/Solana request handling and consent.
- `useVaultAutofillRequests`: vault autofill consent and reply.
- `useElectrobunWebviewRegistry`: refs, host-message registration,
  `toggleHidden`, `togglePassthrough`, `syncDimensions`, renderer registry.
- `BrowserTabRail`, `BrowserToolbar`, `BrowserSurface`,
  `BrowserBridgeInstallPanel`.

Validation:

- Existing `packages/app/test/ui-smoke/browser-workspace.spec.ts`.
- Add focused smoke for reload button in web mode.
- Add desktop/electrobun manual verification for consent dialog stacking over
  `<electrobun-webview>`.
- Verify Agent/App tabs remain read-only context and User tabs remain mutable.

### W4-C: Runtime Gate and Reload Cleanup

Goal: make runtime switching explicit before removing hard reload.

Checklist:

- Extract URL helpers already around `readPickerTargetOverride`,
  `resolveRuntimeChoices`, and runtime URL merge into pure modules.
- Extract cloud provisioning controller from `RuntimeGate`.
- Add a reducer for runtime picker transitions: choose cloud, choose remote,
  choose local, retry, cancel, complete.
- Only after that, replace `reloadIntoRuntimePicker` with a
  `runtimeSession.resetToPicker(target)` action.

Validation:

- Existing onboarding/runtime tests:
  `packages/ui/src/onboarding/__tests__/deep-link-entry.test.ts`,
  `packages/ui/src/state/startup-phase-runtime.test.ts`,
  `packages/ui/src/components/shell/RuntimeGate.cloud-provisioning.test.tsx`.
- Browser flows: local to picker, remote to picker, cloud to picker, picker
  target preselect via `runtimeTarget`.
- Mobile web/native mode still clears persisted active server and runtime mode.

### W4-D: LifeOps UI Resource Boundaries

Goal: reduce LifeOps page-local polling/fanout without touching the
`ScheduledTask` architecture or plugin-health contracts.

Checklist:

- Keep LifeOps as separate plugin UI. Do not import plugin-health internals.
- Extract `LifeOpsWorkspaceView` data into calendar and Gmail hooks.
- Make `useGoogleLifeOpsConnector` the only owner of Google connector status
  polling.
- Replace `LifeOpsOverviewSection.refresh` fanout with a single resource
  coordinator.
- Keep `client-lifeops.ts` registration behavior, but start a plugin-local
  typed adapter for new code.

Validation:

- LifeOps enabled gate, setup gate dismissed/cleared, GitHub owner/agent OAuth
  callback.
- Calendar today/week, Gmail triage/search/recommendations/reply/send/manage.
- Messaging connector cards: Discord, Telegram, Signal, WhatsApp, iMessage
  refresh buttons still update only their card.
- No changes to task primitive or runner behavior.

### W4-E: API Client Seam Cleanup

Goal: reduce route/client coupling without breaking the public singleton.

Checklist:

- Freeze new prototype augmentation in `packages/ui/src/api/client.ts`.
- Split `client-agent.ts` into route-domain files behind the same imports.
- Split `client-chat.ts` into chat, inbox, documents, memory, MCP, workbench.
- Create common transport/auth helper used by both `ElizaClient.rawRequest`
  and `fetchWithCsrf`.
- Add typed adapters for plugin-owned APIs, starting with LifeOps:
  `createLifeOpsClient(client)`.

Validation:

- `packages/ui/src/api/client-base-timeout.test.ts`
- `packages/ui/src/api/csrf-client.test.ts`
- Android/iOS/desktop transport tests under `packages/ui/src/api`.
- Chat stream SSE tests or a focused manual chat stream smoke.

### W4-F: Design and CSS Consolidation

Goal: remove global cascade surprises and make visual cleanup verifiable.

Checklist:

- Decide whether `base.css` or `theme.css` is canonical.
- Scope `styles.css` global scrollbar selectors away from `*`.
- Move Settings-specific overrides out of `brand-gold.css` substring selectors.
- Move logs/plugin game card classes to their owning components or shared UI
  primitives.
- Create shared compact panel, toolbar button, empty state, and data sidebar
  primitives for Database/Vector/Logs/Secrets pages.
- Keep cards at 8px radius unless an existing design system exception is
  explicitly retained.

Validation:

- Dark/light screenshots for chat, settings, browser, database, plugins,
  LifeOps, and companion.
- Mobile screenshots at 390x844 and desktop at 1440x1000.
- Confirm no text overflow in buttons/pills and no nested page-section cards.

## UI Validation Scenarios

These are the minimum behavior scenarios before any Wave 4 implementation is
approved.

1. Startup and Runtime

- Fresh app with no storage shows RuntimeGate picker.
- Existing local runtime starts without picker.
- Settings -> Runtime -> Cloud/Remote/Local opens picker with target selected.
- Backend unavailable shows retryable startup failure, then recovers.
- Reset returns to onboarding/runtime gate and clears stale chat/profile state.

2. Chat and Page Chat

- Type quickly in global chat; no visible lag, cursor jumps, or shell rerender
  flicker.
- Send a text message, stream response, stop response, retry, edit, clear.
- Attach 1-4 images; fifth image is clipped before send.
- Switch conversations while TTS is speaking; old speech stops and new thread
  can speak.
- Select a terminal PTY session; terminal panel owns the full chat area.
- Select an inbox chat; send-as picker/confirmation blocks first write and then
  sends.
- Page-scoped chat in Browser/Wallet/Settings keeps separate routing metadata.

3. Browser Workspace

- Open `example.com` from `/browser`, create `about:blank`, switch tabs,
  navigate selected tab.
- Reload selected tab in web mode and desktop mode.
- Collapse User/Agent/App tab groups; persistence survives navigation.
- Browser Bridge panel refreshes without creating duplicate polling.
- Wallet `eth_requestAccounts`, `eth_sendTransaction`, Solana `connect`, and
  vault autofill consent dialogs render above webview and remain clickable.
- Agent/App tabs are not mutated by page-scoped chat instructions.

4. LifeOps

- Enable LifeOps from disabled state.
- Overview refresh updates overview, screen time, social, calendar, messages,
  and mail without multiple spinners fighting.
- Calendar Today/Week windows load and event composer creates an event.
- Gmail search, reply-needed filter, draft, send confirmation, and bulk manage
  flows preserve selected message state.
- GitHub owner and agent setup callbacks update settings without page reload.

5. Settings and Plugin Surfaces

- Settings sections deep-link and focused connector flash works.
- Connectors refresh/account card actions do not refresh the whole app.
- Plugins toggle, config save, install/uninstall notices still display restart
  banners.
- Skills marketplace refresh and manual GitHub install still work.
- Desktop workspace diagnostics polling pauses when section unmounts.

6. Visual Regression

- Routes from `CORE_ROUTE_PROBES` render at desktop and mobile sizes.
- No overlapping header/mobile nav/chat composer.
- No button label truncation in runtime picker, browser toolbar, connector
  cards, LifeOps cards, or plugin filters.
- No global scrollbar styling leaks into embedded browser/webview surfaces.

## Browser Verification Plan

Use existing Playwright smoke coverage first, then add targeted checks as code
is split.

Baseline commands for an implementation PR:

```sh
bun run --cwd packages/ui lint
bun run --cwd packages/ui typecheck
bun run --cwd packages/ui test
bun run --cwd packages/app lint
bun run --cwd packages/app typecheck
bun run --cwd packages/app test:e2e
```

Focused Playwright runs:

```sh
bun run --cwd packages/app test:e2e -- test/ui-smoke/all-pages-clicksafe.spec.ts
bun run --cwd packages/app test:e2e -- test/ui-smoke/browser-workspace.spec.ts
bun run --cwd packages/app test:e2e -- test/ui-smoke/onboarding-full-flow.spec.ts
bun run --cwd packages/app test:e2e -- test/ui-smoke/connectors.spec.ts
bun run --cwd packages/app test:e2e -- test/ui-smoke/automations.spec.ts
```

Visual/manual browser checks:

- Start `bun run dev:ui` for UI-only review when API routes can be mocked.
- Start `bun run dev:desktop` for Electrobun/webview checks.
- Capture desktop 1440x1000 and mobile 390x844 screenshots for:
  `/chat`, `/settings`, `/browser`, `/apps`, `/automations`, `/wallet`,
  `/character`, `/apps/lifeops`, `/apps/runtime`, `/apps/logs`.
- For 3D companion surfaces, verify the scene is nonblank, correctly framed,
  and not hidden behind shell chrome after context/CSS changes.

## Risks and Owner Questions

- `useApp()` is a public-ish package surface. Plugin UIs import it from
  `@elizaos/ui`; context splits must keep the facade until consumers migrate.
- Some hard reloads are safety mechanisms. Removing
  `reloadIntoRuntimePicker` before RuntimeGate has an equivalent reset action
  risks stale base URLs, tokens, WebSocket handles, or mobile runtime mode.
- Browser Workspace desktop mode depends on fragile native OOPIF masking and
  dimension sync. Component extraction must preserve exact ordering of
  `toggleHidden`, `togglePassthrough`, and `syncDimensions`.
- LifeOps cleanup must not introduce a second task primitive, second graph
  store, prompt-text behavior matching, or direct plugin-health imports.
- CSS token consolidation can silently alter brand, onboarding, and Settings
  contrast. Visual review must cover dark and light themes.
- Changing `fetchWithCsrf` or `ElizaClient.rawRequest` can break mobile native
  transports, desktop relay, and cloud-auth cookies. Transport tests are
  required before merging.
- Splitting large API files can create circular imports if augmentation modules
  import the barrel instead of `client-base`.
- Existing tests stub many API routes in `packages/app/test/ui-smoke/helpers.ts`;
  adding new resource boundaries may require updating route mocks before UI
  behavior can be assessed.

Owner questions:

- Should `theme.css` remain a public package asset, or can `base.css` become
  the only canonical theme root?
- Is a lightweight homegrown resource hook preferred, or should the app adopt
  TanStack Query more broadly after dependency review?
- Which plugin UIs are external compatibility commitments for `useApp()`?
- Can cloud frontend reloads in `cloud/apps/frontend` be included in Wave 4, or
  should they be a separate cloud cleanup wave?

## Implementation Checklist

Pre-work:

- [ ] Capture baseline `wc -l` and render-count metrics for the files listed
  above.
- [ ] Capture baseline desktop/mobile screenshots for high-traffic routes.
- [ ] Confirm owners for `packages/ui`, `packages/app`, LifeOps, companion,
  cloud frontend, and API client.
- [ ] Record `useApp()` consumers by domain with `rg "useApp\\(" packages plugins`.

Context/state:

- [ ] Freeze additions to `AppState`, `AppActions`, and `setState`.
- [ ] Introduce domain context providers behind `AppProvider`.
- [ ] Migrate ChatView to chat/runtime/notification hooks instead of full
  `useApp()`.
- [ ] Migrate AppWorkspaceChrome/PageScopedChatPane to narrower interfaces.
- [ ] Keep `useApp()` facade green until all plugin consumers are audited.

Refresh/reload:

- [ ] Add a cancellable resource hook pattern with `refresh`, `silent`,
  visibility gating, stale snapshot retention, and last-error state.
- [ ] Apply it to Browser Workspace.
- [ ] Apply it to LifeOps overview/workspace.
- [ ] Replace hard reloads only after equivalent state invalidation exists.

Component decomposition:

- [ ] Split BrowserWorkspaceView resource hooks first, then render components.
- [ ] Split RuntimeGate pure helpers and reducer before UI extraction.
- [ ] Split LifeOpsWorkspaceView by Calendar/Gmail/Connector concerns.
- [ ] Split config renderer traversal from field rendering.

CSS/design:

- [ ] Decide canonical theme file.
- [ ] Scope global scrollbar CSS.
- [ ] Move page-specific selectors out of `brand-gold.css`.
- [ ] Replace long arbitrary gradient/shadow class strings with shared
  primitives where repeated.
- [ ] Run screenshot review before and after each CSS batch.

API/client:

- [ ] Extract common auth/transport utility for `ElizaClient` and
  `fetchWithCsrf`.
- [ ] Split `client-agent.ts` and `client-chat.ts` by route domain.
- [ ] Keep prototype augmentation compatibility imports stable.
- [ ] Add plugin-owned client adapters for new LifeOps code.

Final gates:

- [ ] `bun run --cwd packages/ui lint`
- [ ] `bun run --cwd packages/ui typecheck`
- [ ] `bun run --cwd packages/ui test`
- [ ] `bun run --cwd packages/app lint`
- [ ] `bun run --cwd packages/app typecheck`
- [ ] `bun run --cwd packages/app test:e2e`
- [ ] Manual desktop Electrobun Browser Workspace webview verification.
- [ ] Manual dark/light visual review for changed CSS surfaces.
