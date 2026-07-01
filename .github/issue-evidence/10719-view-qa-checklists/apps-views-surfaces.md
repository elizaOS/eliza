# Apps / Views / Overlay Surfaces — QA Checklist

Scope: `packages/ui/src/components/apps/*`, `components/pages/AppsView.tsx` + `AppsPageView.tsx`, `components/views/DynamicViewLoader.tsx`, `App.tsx` `ViewLayoutSurface` + `GameViewOverlay` + `WalletInventoryPage`, `overlay-app-registry.ts`.
Coverage legend: **[T]** committed test exercises it (path cited) · **[GAP]** no committed coverage found · **[PARTIAL]** adjacent/unit-only, not the real interaction.

---

## AppsPageView (`/apps`, tab `apps`)

### Entry / Nav
- [ ] Reach via launcher `apps` tab route `/apps` (TAB_PATHS `apps → /apps`) shows `AppsView` inside `ShellViewAgentSurface viewId="apps"`. **[PARTIAL]** `apps-session.spec.ts` routes into apps; no bare-`/apps` landing assert.
- [ ] Deep sub-routes `/apps/tasks|files|plugins|skills|fine-tuning|trajectories|transcripts|relationships|memories|runtime|database|logs` each resolve to their page via `getAppSlugFromPath` (`renderAppsSurface`). **[T]** `route-coverage.test.ts`, `apps-builtin-pages-interactions.spec.ts`.
- [ ] Fresh reload on `/apps/<slug>` restores the same sub-page (no bounce to launcher). **[T]** `apps-session.spec.ts` ("survive a reload").
- [ ] `/apps` with no slug renders `HomeScreenMount initialPage="launcher"` not AppsView (`renderAppsSurface` guard). **[GAP]**
- [ ] `inModal` render path wraps AppsView in `settings-content-area` with apps accent tokens (used when apps shown inside settings/modal). **[GAP]**
- [ ] From chat "show me my apps" / "open apps" navigates to `/apps`. **[PARTIAL]** `view-switching-chat-e2e.spec.ts` covers view switching generally, not apps specifically.
- [ ] Games sub-tab: when `appsSubTab==="games"` and `activeGameRunId` set, `AppsPageView` returns `<GameView/>` instead of catalog. **[T]** `AppsView.mockapp.test.tsx` ("games-sub-tab" branch renders).
- [ ] Effect: `appsSubTab==="games"` + active game rewrites URL to `/apps/<slug>` via `replaceState` (or `location.hash` in hash-nav). **[GAP]**
- [ ] Effect: `appsSubTab==="games"` with NO active game auto-resets to `"browse"` (no stuck empty game screen). **[GAP]**

### Primary interactions
- [ ] Sidebar (`AppsSidebar`) category rows filter the catalog; `onLaunchApp` launches. **[PARTIAL]** `AppsView.mockapp.test.tsx` renders sidebar; no per-category filter assertion.
- [ ] Catalog tile click → `handleLaunch(app)` → `client.launchApp(app.name)` network call, run appears in `RunningAppsRow`. **[GAP]** (no e2e asserting launchApp POST + row appearance).
- [ ] `RunningAppsRow` shows active runs; row action stops/focuses the run. **[GAP]**
- [ ] Launching an overlay-type app registers via `registerOverlayApp` / routes through overlay path; game-type opens GameView. **[PARTIAL]** overlay registry unit-tested, launch wiring not.
- [ ] Search input filters catalog by `searchQuery` (passed to `AppsCatalogGrid`). **[GAP + BUG SUSPECT]** setter is `_setSearchQuery` (underscore, never invoked) in `AppsView.tsx:286` — search box appears non-functional/dead; confirm whether any control mutates `searchQuery`.
- [ ] Wallet-enabled build shows wallet-gated catalog entries (`walletEnabled` in the memo deps). **[T]** `AppsView.mockapp.test.tsx` ("wallet-enabled" renders).
- [ ] Favorites: `favoriteApps` set drives a favorites section; toggling favorite persists. **[PARTIAL]** `AppsView.mockapp.test.tsx` builds favorite-names Set from override; toggle persistence untested.

### State matrix
- [ ] Empty catalog (`loadAppsCatalog` returns none) → empty state, not blank. **[GAP]**
- [ ] Loading/skeleton while `loadAppsCatalog` in flight. **[GAP]**
- [ ] `loadAppsCatalog` failed-fetch → error surface, retry path. **[GAP]**
- [ ] Offline: catalog served from `apps-cache` if present. **[GAP]** (`apps-cache.ts` exists; no offline test).
- [ ] AOSP-only apps hidden on stock Android/iOS/desktop via `getAvailableOverlayApps`. **[T]** `overlay-app-registry.test.ts` (all platform-gating cases).
- [ ] Many apps (100+) → grid virtualizes/scrolls without jank; zero apps → guidance copy. **[GAP]**

### Repeated / rapid-fire
- [ ] Double/triple-click a tile does NOT spawn duplicate runs (`handleLaunch` idempotent per app while a launch is in flight). **[GAP]**
- [ ] Spam-toggle games sub-tab ↔ browse: no latched game screen, `appsSubTab` reset effect wins. **[GAP]**
- [ ] Rapid launch of same app twice → single `client.launchApp` or dedup by run. **[GAP]**

### Back-and-forth / switching & recovery
- [ ] Launch app → navigate away → return: running run still listed, not re-launched. **[GAP]**
- [ ] Enter game → back-button → catalog restored, `activeGameRunId` cleared or game resumable. **[GAP]**
- [ ] Background app mid-launch and resume: pending launch not double-fired. **[GAP]**
- [ ] Scroll catalog, open app, back → scroll position restored. **[GAP]**

### Fuzz / adversarial
- [ ] Search box (if wired) accepts huge paste / emoji / RTL / whitespace-only without crashing filter memo. **[GAP]**
- [ ] App with pathological `displayName`/`icon` (missing, huge, emoji) renders bounded tile. **[PARTIAL]** `helpers-icons.test.ts` covers icon fallbacks (unit).
- [ ] Invariant: no launch ever navigates to a cross-origin URL from catalog metadata. **[GAP]**

### Input modalities
- [ ] Keyboard: Tab reaches sidebar rows + tiles in DOM order; Enter launches focused tile; Escape closes game. **[GAP]**
- [ ] Touch (mobile viewport): tap tile launches; sidebar collapses/drawer behavior. **[PARTIAL]** `settings-mobile-load.spec.ts` pattern exists for mobile; not apps.
- [ ] Right-click on a tile — context menu wired? (verify none/expected). **[GAP]**

### A11y / geometry
- [ ] axe pass on `/apps` after launch. **[PARTIAL]** `all-views-aesthetic-audit.spec.ts` runs aesthetic/axe sweep across views.
- [ ] Tiles ≥44px tap target; hover orange→darker-orange (never orange→black), no blue. **[PARTIAL]** `all-views-aesthetic-audit.spec.ts` / `settings-theme-audit.spec.ts` enforce color rules globally.
- [ ] Focus visible on tiles/rows; reduced-motion respected on grid animations. **[GAP]**

### Concurrency / races
- [ ] Launch app A while A-catalog still loading → no orphan run. **[GAP]**
- [ ] Two rapid launches of different apps → both runs tracked distinctly. **[GAP]**

---

## AppsView catalog internals (`AppsCatalogGrid`, `AppsSidebar`, `RunningAppsRow`)

- [ ] `AppsCatalogGrid` renders provided apps filtered by `searchQuery`; `onLaunch` fires per tile. **[PARTIAL]** stories smoke `apps-stories-smoke.test.tsx` renders stories; no launch assertion.
- [ ] `AppsSidebar` category selection changes visible set; `onLaunchApp` path. **[GAP]**
- [ ] `RunningAppsRow` derives from `appRuns` + `catalogApps`; empty when no runs. **[GAP]**
- [ ] `filterAppsForCatalog` excludes disabled/kind-gated apps (`enabledKinds`). **[PARTIAL]** helper likely unit-covered via `catalog-loader.test.ts`; verify.
- [ ] `launch-history.ts` caps retained history at max; older entries evicted. **[GAP]** (has "Max items retained" comment; no test cited).
- [ ] Story-gate renders every AppsView story state without throw/blank/axe-critical. **[T]** `apps-stories-smoke.test.tsx` + `__tests__/apps-stories-smoke.test.tsx`.

---

## ViewLayoutSurface — split / tiled panes (`/views`, tab `views`)

### Entry / Nav
- [ ] `/views` route renders launcher; a `split-view`/`tile` action from view-manager builds an `ActiveViewLayout` and mounts `ViewLayoutSurface` (`data-testid=view-layout-surface`). **[T]** `view-manager-actual-flow.spec.ts` (creates split, asserts panes + close).
- [ ] `layout.mode==="split"` → 2-pane grid (`grid-cols-1 md:grid-cols-2`), stacked when hint matches vertical/rows/top/bottom (`splitLayoutIsStacked`). **[PARTIAL]** e2e builds one horizontal split; stacked/vertical branch **[GAP]**.
- [ ] `layout.mode==="tile"` grid scales 1→2→3 cols by count (`viewLayoutGridClass`). **[GAP]**
- [ ] Header label reads "Split view"/"Tiled views" (`viewLayoutLabel`) + shows pane count. **[PARTIAL]** e2e checks panes visible, not the label text.
- [ ] Reload on an active layout: is layout restored or reset? (`viewLayout` is component `useState`, not persisted) — assert reset-to-launcher on reload. **[GAP]**

### Primary interactions
- [ ] Each pane routes: `bundleUrl` panes mount `DynamicViewLoader`; static panes mount `ViewRouter` with `routeOverride` from `routeOverrideForView`. **[T]** `view-manager-actual-flow.spec.ts` (notes remote + simple-calendar static).
- [ ] Close button (`view-layout-close`, aria "Close layout") calls `onClear` → surface unmounts (count 0). **[T]** `view-manager-actual-flow.spec.ts`.
- [ ] Pane header shows each view's `label`; unknown viewIds filtered out (`entries` filter). **[GAP]** (filter path, incl. a layout with a stale/deleted viewId).
- [ ] Layout with zero resolvable views → "Requested views are not available." fallback. **[GAP]**

### State matrix
- [ ] One pane fails to load (bundle error) → that pane shows `ViewErrorState`, sibling pane stays live (ErrorBoundary isolation). **[GAP]**
- [ ] Mixed remote + static panes both render concurrently. **[T]** `view-manager-actual-flow.spec.ts`.
- [ ] Many panes (>3) overflow into scroll region, not clipped. **[GAP]**

### Repeated / rapid-fire
- [ ] Rapid open split → close → open again: no leaked panes, close always fully clears. **[PARTIAL]** e2e does one round-trip only.
- [ ] Mash close button twice: idempotent (already unmounted, no throw). **[GAP]**

### Back-and-forth / recovery
- [ ] Switch to another tab with a layout active then back to `/views`: layout state (component-local) — verify expected reset vs restore. **[GAP]**
- [ ] Reload mid-split: panes re-import bundles fresh (module cache cold across reload). **[GAP]**

### Fuzz / adversarial
- [ ] Layout referencing a viewId that is a huge/garbage string → filtered, no crash. **[GAP]**
- [ ] Split layout with duplicate viewIds → both panes render or dedup (define expected). **[GAP]**

### Input modalities
- [ ] Keyboard: Tab into panes; close button reachable + Enter-activates. **[GAP]**
- [ ] Touch: panes scroll independently; close target ≥44px (button is `h-7 w-7`=28px → **flag tap-target < 44px**). **[GAP]**

### A11y / geometry
- [ ] Close button `aria-label`/`title` "Close layout" present (verified in source). **[T]** implicitly via `view-manager-actual-flow.spec.ts` locator.
- [ ] axe pass with a split layout mounted. **[GAP]**
- [ ] Pane borders/hover follow neutral hover rules (no blue). **[PARTIAL]** global aesthetic audit.

### Concurrency / races
- [ ] Open a split while a prior single-view load is pending: pending load cancels cleanly (`DynamicViewLoader` lease.release). **[PARTIAL]** loader cancellation unit-tested; layout-level **[GAP]**.

---

## DynamicViewLoader — remote bundle load (`components/views/DynamicViewLoader.tsx`)

### Entry / Nav
- [ ] Mounted for any `remoteView.bundleUrl` route (`renderRemoteView`) and for bundle panes in ViewLayoutSurface. **[T]** `plugin-views-lifecycle.spec.ts`, `plugin-view-agent-bridge-inventory.spec.ts`.
- [ ] First navigation triggers `import(bundleUrl)`; re-mount of same `bundleUrl::componentExport` served from `bundleModuleCache` (no re-fetch). **[T]** `DynamicViewLoader.test.tsx` ("imports absolute remote bundleUrl", retain/evict cases).

### Primary interactions / capabilities
- [ ] `get-text` returns container `innerText`; `get-state` prefers agent-surface snapshot else `[data-view-state]` JSON. **[T]** `DynamicViewLoader.test.tsx`.
- [ ] `refresh` invalidates cache + bumps `reloadKey` → re-import. **[T]** `DynamicViewLoader.test.tsx` ("refresh re-imports").
- [ ] `focus-element` / `click-element` / `fill-input` by selector/name/agentId; `setNativeInputValue` dispatches input+change (React round-trip). **[T]** `DynamicViewLoader.test.tsx`.
- [ ] Invalid click/fill/focus reports `{ok:false,reason}` without mutating DOM. **[T]** `DynamicViewLoader.test.tsx`.
- [ ] Module `interact` export delegated for non-standard capabilities; standard caps take precedence. **[T]** `DynamicViewLoader.test.tsx` ("standard capabilities take precedence").
- [ ] Interact handler registered after load, unregistered on unmount/bundle-change. **[T]** `DynamicViewLoader.test.tsx` ("unregisters the previous interact handler").
- [ ] DOM agent-surface caps (`list-elements`, `agent-fill`, `agent-click`, `agent-scroll-to`, `describe-element`, `get-focus`) operate on `[data-agent-id]` when registry empty. **[PARTIAL]** interact tests cover standard caps; DOM-agent branch **[GAP for some caps]**.

### State matrix
- [ ] Loading → `ViewLoadingSkeleton` (spinner + "Loading view…"). **[PARTIAL]** `plugin-views-lifecycle.spec.ts` waits past "Loading view".
- [ ] Load error / bad export → `ViewErrorState` with viewId + error.message + Retry/Back. **[T]** `DynamicViewLoader.test.tsx` ("renders the error state when a bundle does not export a component").
- [ ] Retry re-imports a fixed bundle and recovers a render-crash (ErrorBoundary keyed by `bundleUrl:reloadKey`). **[T]** `DynamicViewLoader.test.tsx` ("recovers a view that crashes at render").
- [ ] iOS/Play store build (`isDynamicViewLoadingAllowed()===false`) → `ViewRestrictedState`, no import attempted. **[PARTIAL]** guard unit-covered elsewhere (`platform-guards`); loader restricted render **[GAP]**.
- [ ] Cross-origin `bundleUrl` refused (`isSameOriginBundleUrl` RCE gate). **[T]** `DynamicViewLoader.test.tsx` ("rejects cross-origin bundle URLs (the RCE vector)").
- [ ] Same-origin `/api/views/` bundle rewritten with `hostExternalRuntime=1` + specifiers. **[PARTIAL]** import path tested; host-external rewrite URL params **[GAP]**.

### Repeated / rapid-fire
- [ ] Rapid `refresh` capability calls coalesce (no dup imports, no spinner latch). **[GAP]**
- [ ] Mount/unmount same view rapidly: refCount balanced, retention timer armed once. **[T]** `DynamicViewLoader.test.tsx` ("retains inactive bundles after unmount").
- [ ] Bundle that resolves after loader unmounted → cleanup runs, not applied to dead component. **[T]** `DynamicViewLoader.test.tsx` ("retains then evicts a bundle that resolves after unmount", "cleans up a pending bundle evicted before resolution").

### Back-and-forth / recovery
- [ ] Switch view A→B→A: A served from cache instantly (within TTL). **[T]** retain/evict tests.
- [ ] App pause / `visibilitychange hidden` / `memorypressure` prunes idle bundles + runs cleanup. **[T]** `DynamicViewLoader.test.tsx` ("evicts inactive bundles on app pause", lifecycle-listener removal).
- [ ] Low-memory device (`deviceMemory<=4`) shrinks cache to 2 entries / 60s TTL. **[GAP]** (thresholds in code; no test cited).
- [ ] Dev-mode ETag HEAD poll (2s) reloads on bundle change. **[T]** `DynamicViewLoader.test.tsx` ("polls bundle HEAD in dev mode").

### Fuzz / adversarial
- [ ] `fill-input` with non-string value → `{filled:false,reason:"value must be a string"}`. **[T]** covered by invalid-fill test.
- [ ] `bundleUrl` that throws non-"Failed to resolve module specifier" error → rethrown (not silently rewritten). **[GAP]**
- [ ] Malformed `[data-view-state]` JSON → empty `{}` (no throw). **[T]** `DynamicViewLoader.test.tsx` ("falls back to empty state for invalid data-view-state JSON").
- [ ] `viewId` change with same `bundleUrl` must NOT re-import or flash skeleton (viewIdRef, not a dep). **[GAP]** (explicit invariant in code; assert it).

### Concurrency / races
- [ ] Two panes importing the same bundle share one cache entry/promise (refCount 2). **[GAP]**
- [ ] Nav-away cancels in-flight import (`cancelled` flag, lease.release). **[PARTIAL]** covered indirectly by unmount tests.

---

## GameView (fullscreen, `appsSubTab==="games"`)

### Entry / Nav
- [ ] Launch a game-type app → `activeGameRunId` set → `AppsPageView` renders `GameView` fullscreen. **[PARTIAL]** `AppsView.mockapp.test.tsx` renders games branch (no real launch).
- [ ] Reload with `activeGameRunId` restored from sessionStorage keeps game open + URL synced to `/apps/<slug>`. **[GAP]**
- [ ] `DesktopGameWindowControls` render on desktop (exit/window controls). **[GAP]**

### Primary interactions
- [ ] Game iframe embeds running app client; disconnected session shows `buildDisconnectedSessionState` message. **[GAP]**
- [ ] Steering notice / fallback message (`getSteeringNotice`, `getSteeringFallbackMessage`) shown per telemetry. **[GAP]**
- [ ] Exit/leave returns to catalog and clears `activeGameRunId`. **[GAP]**
- [ ] `getApiStatus` error handling surfaces API failure state. **[GAP]**

### State matrix
- [ ] Loading game client, connected, disconnected, API-error, learning-telemetry present vs absent. **[GAP]** (helpers `readLearningTelemetry` etc. — verify unit coverage under `GameView.helpers.ts`).
- [ ] `GameView.helpers.ts` pure helpers unit-tested. **[PARTIAL]** check for `GameView.helpers.test`; none found → **[GAP]**.

### Concurrency / recovery
- [ ] Background during game → iframe torn down (visibility), resume re-mounts + re-handshakes. **[GAP]**

---

## GameViewOverlay (floating draggable overlay, `gameOverlayEnabled`)

### Entry / Nav
- [ ] Overlay renders when `gameOverlayEnabled && tab!=="views"` and `activeGameRun.viewerAttachment==="attached"` and document visible + resolved viewer URL (`App.tsx:2306`). **[GAP]** (only `App.navigate-view-wiring.test.tsx` references it — wiring, not behavior).
- [ ] Returns null when document hidden / no viewer URL / not attached. **[GAP]**

### Primary interactions
- [ ] Header drag handle (`onMouseDown handleDragStart`) repositions overlay via rAF-throttled `setPos`; drop persists position. **[GAP]**
- [ ] Expand button → `gameOverlayEnabled=false`, `tab="apps"`, `appsSubTab="games"` (back to fullscreen). **[GAP]**
- [ ] Close button → `gameOverlayEnabled=false`. **[GAP]**
- [ ] Iframe `data-testid=game-view-overlay-iframe` uses `activeGameSandbox` sandbox attr + resolved viewer URL. **[GAP]**
- [ ] Resize handle (`resize:both`) resizes the 480×360 overlay. **[GAP]**

### postMessage auth handshake (security-critical)
- [ ] On viewer `ready` event whose `event.source===iframe.contentWindow` AND `event.origin===postMessageTargetOrigin`, posts `activeGamePostMessagePayload` once (`authSentRef`). **[GAP]**
- [ ] Fail-closed: no auth sent when `postMessageTargetOrigin` is null/non-http(s) (`resolvePostMessageTargetOrigin`). **[GAP — but verify `viewer-auth.ts` unit tests]**.
- [ ] Wrong-origin or wrong-source `ready` message is ignored (spoof rejection). **[GAP]**
- [ ] Session change (`viewerSessionKey`) or document-hide resets `authSentRef` so a fresh contentWindow re-handshakes exactly once. **[GAP]**

### Repeated / rapid-fire
- [ ] Mash close/expand: idempotent state set, no double navigation. **[GAP]**
- [ ] Rapid drag start/stop cancels pending rAF (`dragFrameRef` cleanup on unmount). **[GAP]**
- [ ] Duplicate `ready` messages after auth sent are ignored (`authSentRef` guard). **[GAP]**

### Fuzz / adversarial
- [ ] Iframe posts unexpected `type` / attacker origin repeatedly → never triggers auth send. **[GAP]** (adversarial postMessage fuzz — highest-value missing test).
- [ ] `activeGameViewerUrl` = `javascript:`/`data:`/cross-origin → `resolveEmbeddedViewerUrl` sanitizes or overlay refuses. **[PARTIAL]** verify `viewer-auth.ts` tests.

### Input modalities
- [ ] Touch drag on mobile (currently `onMouseDown` only — flag: no pointer/touch events, drag likely broken on touch). **[GAP + BUG SUSPECT]**.
- [ ] Keyboard: close/expand buttons focusable + Enter-activatable. **[GAP]**

### A11y / geometry
- [ ] Header drag button `aria-label` `aria.dragOverlay`; close/expand `title` present. **[GAP]** (present in source, untested).
- [ ] Overlay z-50 does not trap pointer over whole screen (`pointer-events-none` wrapper, `pointer-events-auto` panel). **[GAP]**
- [ ] Colors: overlay chrome uses neutral/gold border, no blue. **[PARTIAL]** global aesthetic audit does not reach overlay (needs game attached).

---

## overlay-app-registry (`overlay-app-registry.ts`)

- [ ] `registerOverlayApp`/`getOverlayApp`/`getAllOverlayApps` share one `window.__elizaosOverlayAppRegistry__` Map across chunks. **[GAP]** (single-registry invariant untested).
- [ ] `getAvailableOverlayApps` hides `androidOnly` apps on stock Android, iOS, desktop; shows on AOSP elizaOS + white-label AOSP. **[T]** `overlay-app-registry.test.ts` (all 6 platform cases).
- [ ] Legacy string-context API hides androidOnly without explicit AOSP flag. **[T]** `overlay-app-registry.test.ts`.
- [ ] `isAospAndroid` agrees with gate semantics. **[T]** `overlay-app-registry.test.ts`.
- [ ] `overlayAppToRegistryInfo` maps to `RegistryAppInfo` (launchType "overlay", supports.v2 true). **[GAP]**
- [ ] `detectPlatformForCatalog` prefers `Capacitor.getPlatform()` over UA sniff. **[PARTIAL]** implied by platform tests.

---

## WalletInventoryPage / Inventory (`/wallet`, tab `inventory`)

### Entry / Nav
- [ ] `/wallet` route (TAB_PATHS `inventory → /wallet`) → `tab==="inventory"` → `WalletInventoryPage` in `TabScrollView`. **[PARTIAL]** `wallet-keys.spec.ts` / `cloud-wallet-import.spec.ts` exercise inventory; direct `/wallet` landing assert **[GAP]**.
- [ ] Resolves registered app-shell page `wallet.inventory` (id or path `/inventory`); when unregistered shows "Wallet is not registered in this build." **[GAP]** (unregistered-build fallback).
- [ ] Remote inventory view also routable via `componentExport` spec `@elizaos/plugin-wallet-ui#InventoryView` (`App.tsx:600`, `:685`). **[PARTIAL]** `plugin-view-agent-bridge-inventory.spec.ts`.
- [ ] From chat "open my wallet/inventory" navigates to `/wallet`. **[GAP]**

### Primary interactions
- [ ] Add wallet key → reveal → delete round-trip hits key API. **[T]** `wallet-keys.spec.ts` ("adds, reveals, and deletes a wallet key end to end").
- [ ] Cloud import uses live wallet API and refreshes cloud wallets after save. **[T]** `cloud-wallet-import.spec.ts` (both tests).
- [ ] Balance/holdings list renders from wallet state; row actions (send/copy address) behave. **[GAP]**
- [ ] `VaultInventoryPanel` (settings Vault) parity — secrets vs wallet inventory not conflated. **[GAP]**

### State matrix
- [ ] Empty inventory (no keys/holdings) → empty state + add CTA. **[GAP]**
- [ ] Loading balances / import in flight → skeleton. **[GAP]**
- [ ] Wallet API failure → error surface, retry. **[GAP]**
- [ ] Unauthenticated/guest → gated view or connect prompt. **[GAP]**
- [ ] Long address / huge balance / many tokens overflow-safe. **[GAP]**

### Repeated / rapid-fire
- [ ] Submit "add key" twice quickly → single key, no dup rows. **[PARTIAL]** `wallet-keys.spec.ts` covers single add; double-submit **[GAP]**.
- [ ] Mash cloud-import save → single import, no dup wallets. **[GAP]**
- [ ] Reveal/hide key spam → state consistent, secret not left exposed. **[GAP]**

### Back-and-forth / recovery
- [ ] Start add-key, navigate away, return → form draft reset or preserved (define expected). **[GAP]**
- [ ] Reload after import → imported wallets persisted. **[PARTIAL]** `cloud-wallet-import.spec.ts` asserts refresh, not reload.

### Fuzz / adversarial
- [ ] Paste invalid/huge private key / seed phrase → validation rejects, no secret logged to console. **[GAP]**
- [ ] Injection-ish wallet label (`<script>`, RTL, emoji) rendered as text. **[GAP]**
- [ ] Negative/NaN amount in any send field rejected. **[GAP]**

### Input modalities
- [ ] Keyboard: Tab order add-key form → reveal → delete; Enter submits, Escape cancels. **[GAP]**
- [ ] Touch: reveal/delete targets ≥44px on mobile. **[GAP]**
- [ ] Copy-address via keyboard + right-click. **[GAP]**

### A11y / geometry
- [ ] axe pass on inventory after add/import. **[PARTIAL]** global `all-views-aesthetic-audit.spec.ts`.
- [ ] Secret reveal toggle has accessible name + secure state; no blue; hover rules. **[GAP]**

### Concurrency / races
- [ ] Cloud import while balance refresh pending → no stale overwrite. **[GAP]**
- [ ] Delete a key while its reveal request in flight → clean cancel. **[GAP]**

---

## Coverage summary

| View / Surface | Existing test path(s) | Biggest gap |
|---|---|---|
| AppsPageView / AppsView | `AppsView.mockapp.test.tsx`, `apps-session.spec.ts`, `apps-builtin-pages-interactions.spec.ts`, `apps-stories-smoke.test.tsx` | No e2e asserting `client.launchApp` fires + run appears in `RunningAppsRow`; search box setter `_setSearchQuery` never called (dead search — likely bug). |
| AppsCatalogGrid / Sidebar / RunningAppsRow | `apps-stories-smoke.test.tsx` (render only), `catalog-loader.test.ts` | Launch/filter/running-run interactions unverified; empty/loading/error catalog states untested. |
| ViewLayoutSurface (split/tiled) | `view-manager-actual-flow.spec.ts` | Only one horizontal-split round-trip; tiled multi-col grid, stacked/vertical split, per-pane error isolation, and reload-restore all untested; 28px close button < 44px tap target. |
| DynamicViewLoader | `DynamicViewLoader.test.tsx` (deep), `plugin-views-lifecycle.spec.ts`, `plugin-view-agent-bridge-inventory.spec.ts` | Strong unit coverage; gaps in restricted-platform render, low-memory cache thresholds, host-external URL rewrite params, and shared-entry refCount across concurrent panes. |
| GameView (fullscreen) | `AppsView.mockapp.test.tsx` (games branch render) | No real launch→play→exit flow; disconnected/steering/API-error states and `GameView.helpers.ts` all untested. |
| GameViewOverlay | `App.navigate-view-wiring.test.tsx` (wiring ref only) | **Biggest gap in group**: zero behavioral coverage of the postMessage auth handshake (origin/source spoof rejection, fail-closed, one-shot `authSentRef`) — a security-critical iframe surface — plus drag is mouse-only (broken on touch). |
| overlay-app-registry | `overlay-app-registry.test.ts` (platform gating) | Single-shared-registry-across-chunks invariant and `overlayAppToRegistryInfo` mapping untested. |
| WalletInventoryPage / Inventory | `wallet-keys.spec.ts`, `cloud-wallet-import.spec.ts`, `plugin-view-agent-bridge-inventory.spec.ts` | Empty/loading/error/guest states, double-submit idempotency, unregistered-build fallback, and adversarial key/seed input (secret-leak) all untested. |

**Single biggest gap:** `GameViewOverlay`'s cross-origin `postMessage` auth handshake — a privileged iframe that ships an auth payload — has no committed behavioral test at all (only a wiring reference), so origin/source spoof rejection, the fail-closed no-target-origin path, and the one-shot `authSentRef` guard are entirely unverified; its drag is also `onMouseDown`-only (no touch/pointer), so overlay repositioning is likely broken on mobile.
