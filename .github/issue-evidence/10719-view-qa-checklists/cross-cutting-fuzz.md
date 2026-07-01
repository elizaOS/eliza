# Cross-Cutting Interaction Fuzz & State Recovery — QA Checklist

Scope: behaviors that span ALL views/tabs/settings-sections — view-switch storms, back/forward, deep-link cold-load, orientation, background/resume, connection loss+recovery, memory-prune, error-boundary recovery, kiosk/overlay transitions, whole-app adversarial fuzz. Route source: `packages/ui/src/navigation/index.ts` (`TAB_PATHS`). Shell modes: `packages/ui/src/App.tsx` `readShellMode()` (`chat-overlay|onboarding-overlay|tray-popover|voice-selftest|voice-workbench|launcher|kiosk|full`). Coverage cited relative to `packages/app/` unless noted.

Legend: `[COVERED: path]` a committed test exercises it · `[PARTIAL: path]` adjacent coverage, invariant not asserted · `[GAP]` no committed test.

---

## Global View-Switching & Tab Storms

- [ ] ENTRY — every `TAB_PATHS` route (chat/phone/messages/contacts/camera/apps/tasks/browser/companion/stream/apps/views/character/automations/wallet/documents/files/plugins/skills/fine-tuning/trajectories/transcripts/relationships/memories/rolodex/voice/runtime/database/desktop/settings/tutorial/help/logs/background) reachable via `eliza:navigate:view` event lands on its declared path `[COVERED: test/ui-smoke/view-switching-core-matrix.spec.ts + view-switching-core-matrix.ts ALL_REQUIRED_VIEW_SWITCH_TARGETS]`
- [ ] Every ordered A→B core-view pair completes navigation without a stuck spinner or blank canvas `[COVERED: test/ui-smoke/view-switching-core-matrix.spec.ts CORE_VIEW_SWITCH_PAIRS]`
- [ ] Coverage-gate: the switch matrix statically tracks every named core view + every canonical settings subsection `[COVERED: test/view-switching-core-matrix-coverage.test.ts]`
- [ ] Per-view interaction surface (buttons/rows) enumerated + reachable after switch-in `[COVERED: test/core-view-interaction-coverage.test.ts, test/view-interaction-coverage.test.ts, test/ui-smoke/all-views-interaction.spec.ts]`
- [ ] RAPID-FIRE — dispatch A→B→A→B 40× in a tight loop; final `location.pathname` equals last target, exactly one view mounted (no stacked duplicates) `[GAP: matrix walks pairs serially with settle, no burst-without-settle storm]`
- [ ] SWITCH mid-load — navigate away while target view's data fetch is in-flight; assert prior request is cancelled/ignored (no late setState into unmounted view, no render-telemetry error) `[PARTIAL: chat-view-memory-stability.spec.ts asserts no render-telemetry errors across cycles]`
- [ ] Switch to a view, scroll to bottom, switch away and back; assert scroll position reset-or-restored per view contract (not frozen mid-list) `[GAP]`
- [ ] Switch into a view with a half-filled form/composer draft, leave, return; draft either persists or clears deterministically (no ghost text) `[GAP: only chat composer draft covered indirectly]`
- [ ] STATE — switching into an empty view shows empty-state, not perpetual skeleton `[PARTIAL: all-pages-clicksafe.spec.ts renders each route but asserts console-clean, not empty-state semantics]`
- [ ] CONCURRENCY — two `eliza:navigate:view` events fired in the same tick resolve to exactly one active view (last-wins, no split render) `[GAP]`
- [ ] FUZZ — seeded random walk across the full tab set (60 steps), assert app never white-screens and heap/nodes stay bounded `[GAP: seeded random-walk exists only for ContinuousChatOverlay, not whole-app view switching]`
- [ ] A11Y — after each switch, focus lands on the new view's primary region / heading (not lost to body); tab order restarts in-view `[GAP]`
- [ ] Hover states on nav tiles: orange→darker-orange, never orange→black, no blue `[COVERED: test/ui-smoke/all-views-aesthetic-audit.spec.ts + aesthetic-audit-rules.ts]`

## Browser History (Back / Forward)

- [ ] ENTRY — chat/settings/character reachable via `openAppPath` then `page.goBack`/`goForward` restores each route + ready selector `[COVERED: test/ui-smoke/history-navigation.spec.ts "preserves route state across back and forward"]`
- [ ] Repeated direct route sequence + full history rewind returns through the exact stack `[COVERED: test/ui-smoke/history-navigation.spec.ts "survives repeated direct route sequences and history rewinds"]`
- [ ] Back-and-forforth never accumulates page diagnostics / console failures `[COVERED: history-navigation.spec.ts expectNoPageDiagnostics]`
- [ ] History across ALL tabs (not just chat/settings/character) — deep back-stack through apps/wallet/automations/logs restores each `[GAP: history spec only covers 3 HISTORY_ROUTES]`
- [ ] Android hardware back-button routes through `window.history.back()` only when `canGoBack` is true; at root it exits/no-ops rather than white-screening `[COVERED: test/mobile-lifecycle.test.ts backButton canGoBack gating]`
- [ ] RAPID — mash back 10× past the start of history; app stays on the earliest valid route, does not navigate to blank/`about:blank` `[GAP]`
- [ ] Back mid-load — `goBack` while a route's data is loading cancels the in-flight fetch for the abandoned route `[GAP]`
- [ ] Deep-link then back — cold-load `/apps/logs`, then back with empty history stack does not crash `[GAP]`
- [ ] Titlebar/desktop nav (Electrobun) back/forward arrows mirror browser history `[COVERED: test/ui-smoke/titlebar-navigation.spec.ts]`

## Deep-Link Cold-Load (every route)

- [ ] Cold reload directly on each `TAB_PATHS` route renders that view without console failure at desktop + mobile viewport `[COVERED: test/ui-smoke/all-pages-clicksafe.spec.ts "route renders without console failures" per viewport]`
- [ ] Route smoke matrix covers catalog + app-window routes; manager-visible view tiles all tracked `[COVERED: test/route-coverage.test.ts route+manager-visible matrix gates]`
- [ ] Every production plugin-view manifest discovered + app-boot mapped (no orphan deep-link target) `[COVERED: test/route-coverage.test.ts manifest ratchet]`
- [ ] Settings deep-link — `/settings/voice` (voice tab) and each settings section id (identity/ai-model/voice/capabilities/apps/connectors/runtime/appearance/remote-plugins/wallet-rpc/updates/advanced/app-permissions/permissions/secrets/security) cold-loads to that section `[PARTIAL: settings-mobile-load.spec.ts renders each section at mobile width; not asserting deep-link scroll-to-section]`
- [ ] Cold-load of a route with a query/hash param (`?shellMode=`, `#/apps/...`) resolves the intended surface `[PARTIAL: readShellMode parses search+hash; no e2e cold-loads each shellMode]`
- [ ] STATE — cold-load unauthenticated/guest: gated routes redirect to onboarding, not a broken shell `[COVERED: test/ui-smoke/first-run-startup.spec.ts, reset-returns-to-onboarding.spec.ts]`
- [ ] Cold-load of a plugin-view route whose plugin is disabled shows a clean not-available state, not a crash `[GAP]`
- [ ] Cold-load with corrupt/partial `localStorage` seed (truncated `steward_session_token`, malformed prefs) recovers to a usable shell `[GAP]`
- [ ] FUZZ — cold-load a nonexistent route `/apps/does-not-exist` lands on a 404/fallback view, never white-screen `[GAP]`
- [ ] Deep-link cold-load while offline shows offline/retry affordance rather than infinite skeleton `[GAP]`

## Orientation Change

- [ ] Rotate portrait→landscape mid-view on chat: composer + transcript reflow, no clipped controls, no horizontal scroll `[GAP: only aesthetic-audit references orientation; no functional rotate test]`
- [ ] Rotate on settings: section list reflows, active section stays selected + scrolled into view `[GAP]`
- [ ] Rotate on a modal/overlay open (Vault modal, computer-use approval): modal stays centered + focus-trapped, does not dismiss `[GAP]`
- [ ] Rotate during an in-flight action (send, download): action completes, no re-trigger on relayout `[GAP]`
- [ ] Orientation via `screen.orientation`/`resize` fires exactly one relayout (no thrash loop) `[GAP]`
- [ ] Landscape on small height: bottom chat pill / nav bar remain reachable + ≥44px tap targets `[GAP]`
- [ ] Keyboard-open on mobile (viewport shrink) treated like orientation: composer stays above keyboard `[PARTIAL: mobile-lifecycle.test.ts mocks @capacitor/keyboard import; no viewport assertion]`

## App Background / Resume Lifecycle

- [ ] `@capacitor/app` `appStateChange` inactive→active dispatches exactly one `APP_RESUME_EVENT` / active→inactive one `APP_PAUSE_EVENT` `[COVERED: test/mobile-lifecycle.test.ts]`
- [ ] Fallback path — `document.visibilitychange` to hidden dispatches `APP_PAUSE_EVENT` even when Capacitor `App` plugin is silent (Android bug #9943) `[COVERED: mobile-lifecycle.test.ts "dispatches APP_PAUSE_EVENT on visibilitychange to hidden"]`
- [ ] visibilitychange back to visible dispatches `APP_RESUME_EVENT` `[COVERED: mobile-lifecycle.test.ts "dispatches APP_RESUME_EVENT on visibilitychange back to visible"]`
- [ ] Pause/resume are DEDUPED across appStateChange + visibilitychange (no double pause/double resume when both fire) `[COVERED: mobile-lifecycle.test.ts idempotency + dedupe assertions]`
- [ ] Double-init of lifecycle registers each native listener exactly once `[COVERED: mobile-lifecycle.test.ts double-init idempotency guards]`
- [ ] Background mid-stream — background the app while an assistant response is streaming; on resume the stream completes or cleanly re-subscribes (no truncated-forever bubble) `[GAP]`
- [ ] Background with an unsent composer draft; resume restores the draft `[GAP]`
- [ ] Cold-launch deep-link via `getLaunchUrl()` and warm `appUrlOpen` both route through `handleDeepLink` `[COVERED: mobile-lifecycle.test.ts cold+warm deep-link bootstrap]`
- [ ] RAPID pause/resume storm 20× leaves exactly-balanced pause/resume counts, no leaked listeners `[COVERED: mobile-lifecycle.test.ts mobile-lifecycle 12/12 storm cases]`
- [ ] Background runner (iOS/Android) records explicit skip instead of probing TCP / fetching custom scheme `[COVERED: test/background-runner.test.ts]`

## Connection Loss & Recovery

- [ ] Reconnecting state shows `ConnectionFailedBanner` with `reconnectAttempt/maxReconnectAttempts`, `role=status aria-live=polite`, spinner `[PARTIAL: component in packages/ui/src/components/shell/ConnectionFailedBanner.tsx + ConnectionFailedBanner.stories.tsx; no e2e forces reconnecting state]`
- [ ] Failed (attempts exhausted) shows the alert banner with Retry, dismissable via `dismissBackendDisconnectedBanner` `[GAP: no e2e drives backendConnection.state='failed']`
- [ ] `ConnectionLostOverlay` (`role=alertdialog aria-modal`) renders only when `state==='failed' && showDisconnectedUI`; shows exhausted-attempts count `[PARTIAL: component exists; ConnectionFailedBanner.stories only]`
- [ ] Restart button — desktop calls `relaunchDesktop()`, web calls `window.location.reload()`; guarded by `busy` so it fires once `[GAP: idempotency of restart not e2e-asserted]`
- [ ] Retry button calls `retryBackendConnection` and transitions banner reconnecting→connected on success (banner disappears) `[GAP]`
- [ ] STATE — connected→reconnecting→connected round-trip restores live streaming without a reload `[GAP]`
- [ ] OFFLINE — `@capacitor/network` `networkStatusChange` dispatches `NETWORK_STATUS_CHANGE_EVENT {connected}` `[COVERED: mobile-lifecycle.test.ts initializeNetworkListener + idempotency]`
- [ ] Offline banner appears on connectivity loss and clears on restore; queued sends flush on reconnect (no dup send) `[GAP: apps-builtin-pages-interactions references offline but no cross-view offline→online recovery]`
- [ ] Two clients on same agent converge after a message (cross-client sync) `[GAP: test/ui-smoke/multi-client-desync.spec.ts is test.skip — no shared backing store in mock layer]`
- [ ] Cross-window preference propagation A→B `[GAP: test/ui-smoke/multi-window-sync.spec.ts is test.skip — sync layer not wired in harness]`
- [ ] RAPID — mash Retry while already reconnecting issues no duplicate reconnect loops `[GAP]`
- [ ] Dismiss the disconnected banner, then a new disconnect re-shows it (dismiss is per-incident, not permanent) `[GAP]`

## Memory-Prune on Background

- [ ] Route-cycling N× keeps JS heap / DOM nodes / listeners bounded within budget (no monotonic growth = leak) `[COVERED: test/ui-smoke/chat-view-memory-stability.spec.ts via CDP Performance.getMetrics, DEFAULT_ROUTE_CYCLES=8, up to 60]`
- [ ] No render-telemetry errors across the cycle storm `[COVERED: chat-view-memory-stability.spec.ts expectNoRenderTelemetryErrors]`
- [ ] Backgrounding triggers retained-lazy memory prune (the pause path that #9943 unblocked) — pruned caches rebuild on resume without stale reads `[PARTIAL: pause event fires (mobile-lifecycle.test.ts); prune-then-rebuild data-integrity not asserted]`
- [ ] Long chat transcript scrolled + backgrounded + resumed does not double-render or lose scroll anchor `[PARTIAL: chat-view-memory-stability covers heap, not scroll anchor]`
- [ ] Heap after 60-cycle storm returns near baseline after `collectGarbage` (no detached-node retention) `[COVERED: chat-view-memory-stability.spec.ts HeapProfiler.collectGarbage + delta assertion]`
- [ ] Listener count is flat across mount/unmount of every tab (no per-switch listener leak) `[PARTIAL: jsEventListeners metric collected; asserted for chat route cycle only, not all tabs]`

## Error-Boundary Recovery

- [ ] A thrown render error inside any view is caught by `ErrorBoundary` (wraps both `packages/ui/src/App.tsx:1352` and `packages/app/src/main.tsx:2093`), shows a fallback instead of white-screen `[GAP: error-boundary.tsx has no committed test that throws-then-recovers]`
- [ ] Error-boundary fallback offers a recover/reload path that remounts the subtree cleanly `[GAP]`
- [ ] Switching away from a crashed view and back re-mounts fresh (boundary resets on route change) `[GAP]`
- [ ] StartupFailureView renders on boot failure with actionable retry `[COVERED: packages/ui/src/components/shell/StartupFailureView.test.tsx]`
- [ ] Warming shell — composer paints while agent warms, then goes live (no crash if a widget errors during warm) `[COVERED: test/ui-smoke/warming-shell-startup.spec.ts]`
- [ ] Widget-level failure inside `WidgetHost` is isolated (one bad widget does not blank the home dashboard) `[PARTIAL: WidgetHost.tsx imports ErrorBoundary; no committed per-widget-crash test]`
- [ ] FUZZ — a plugin view that throws on mount surfaces the boundary, does not cascade to the shell chrome `[GAP]`
- [ ] Reset Everything from a broken state wipes agent + returns to onboarding `[COVERED: test/ui-smoke/reset-returns-to-onboarding.spec.ts + cancel-leaves-untouched case]`

## Kiosk Mode & Shell-Mode Transitions

- [ ] `?shellMode=kiosk` boots the locked appliance shell (single fullscreen view-manager surface + bottom chat pill) `[PARTIAL: readShellMode parses kiosk in App.tsx; referenced in assistant-home-flow/voice specs, no dedicated kiosk-boot e2e]`
- [ ] `KioskViewCanvas` renders each dynamic view as a sandboxed iframe (`allow-scripts allow-same-origin allow-forms`, top-nav locked so a view can't replace the shell) `[GAP: KioskViewCanvas.tsx has no co-located test]`
- [ ] Floating-placement view is a draggable in-canvas panel (pointerDown/Move/Up drag, capture released cleanly) `[GAP]`
- [ ] Drag a floating window rapidly / release pointer outside canvas: no stranded drag, position clamps in-bounds `[GAP]`
- [ ] `?shellMode=chat-overlay` renders ONLY waveform+pill+overlay over transparent bg (no app chrome); `eliza-chat-overlay-shell` class toggled on root+body `[PARTIAL: main.tsx toggles the class; chat-overlay interactions tested in chat-overlay-controls-interactions.spec.ts but not shellMode boot]`
- [ ] `?shellMode=launcher` boots the full home launcher surface `[PARTIAL: launcher-interaction.spec.ts covers launcher UI; not the shellMode= entry]`
- [ ] `?shellMode=onboarding-overlay` toggles `eliza-onboarding-overlay-shell` and renders onboarding-only `[GAP]`
- [ ] `?shellMode=tray-popover` renders the compact tray surface `[GAP]`
- [ ] Unknown/garbage `shellMode` value falls back to `full` (readShellMode default) `[PARTIAL: logic exists in App.tsx; no test asserts the fallback]`
- [ ] TRANSITION — overlay→launcher→kiosk intents open dedicated on-demand windows (`useBarSurfaceWindows`), do not leak a second inline tab system `[GAP]`
- [ ] Kiosk: a sandboxed view cannot navigate the top frame away from the kiosk shell (sandbox lacks `allow-top-navigation`) `[GAP: security invariant, untested]`
- [ ] FUZZ — flip `shellMode` across all 8 values on cold-load; each renders its surface, none white-screens `[GAP]`

## Overlay Surfaces (Chat / Assistant / HomePill / NotificationCenter)

- [ ] ContinuousChatOverlay reaches every named detent state (pilled/half/full/inset) and each satisfies invariants `[COVERED: packages/ui/src/components/shell/ContinuousChatOverlay.fuzz.test.tsx reachable-states]`
- [ ] State × action matrix — every (setup, action) pair stays in a valid state `[COVERED: ContinuousChatOverlay.fuzz.test.tsx state×action matrix]`
- [ ] Out-of-state no-ops — Escape while collapsed, backdrop click while collapsed, Enter on empty draft, flick past detent bounds are all inert `[COVERED: ContinuousChatOverlay.fuzz.test.tsx "out-of-state / nonsensical actions are no-ops"]`
- [ ] Multi-press storms — grabber tap 40×, pill flick-up/grabber flick-down 30×, focus/blur 50×, Escape spam 25×, double-click maximize all end valid `[COVERED: ContinuousChatOverlay.fuzz.test.tsx multi-press storms]`
- [ ] Adversarial pointer streams — orphan pointerUp, double pointerDown+single up, pointerCancel mid-drag, lostPointerCapture, interleaved pointer ids, random-target flood never corrupt state `[COVERED: ContinuousChatOverlay.fuzz.test.tsx adversarial malformed pointer streams]`
- [ ] Seeded 60-step random walk survives (multiple seeds) `[COVERED: ContinuousChatOverlay.fuzz.test.tsx seeded random fuzz]`
- [ ] Single pill tap opens to half (no blink-back, no double-tap regression, bug (a)) `[COVERED: ContinuousChatOverlay.fuzz.test.tsx bug (a)]`
- [ ] Slash-command menu opens/filters/selects from the overlay composer `[COVERED: ContinuousChatOverlay.slash.test.tsx + test/ui-smoke/slash-commands.spec.ts]`
- [ ] Overlay send opens chat, click-out collapses, Escape collapses (real web overlay) `[COVERED: test/ui-smoke/chat-overlay-controls-interactions.spec.ts]`
- [ ] Overlay attach control opens image picker; transcript is selectable; long transcript scrolls inside the log `[COVERED: chat-overlay-controls-interactions.spec.ts]`
- [ ] NotificationCenter renders recent notifications, dismiss removes one, mark-all clears `[COVERED: packages/ui/src/components/shell/NotificationCenter.test.tsx]`
- [ ] HomePill tap opens overlay; long-press / secondary action wired `[GAP: no co-located HomePill test]`
- [ ] AssistantOverlay open/close does not steal focus from an active view's composer `[GAP]`
- [ ] Reduced-motion collapses overlay + shell framer-motion animation `[COVERED: test/ui-smoke/perf-reduced-motion.spec.ts]`
- [ ] FUZZ — open overlay while switching views rapidly; overlay z-order stays above chrome, never orphaned behind a view `[GAP]`

## Cross-Cutting Adversarial Fuzz (whole-app invariants)

- [ ] Paste huge text (>100KB, Claude-Code-style block) into the chat composer collapses into a `pasted-text.md` attachment chip, does not flood/freeze the log `[COVERED: test/ui-smoke/chat-large-paste.spec.ts]`
- [ ] Emoji / RTL / IME / combining-char / whitespace-only input in every text field round-trips or is rejected cleanly (no layout break, no crash) `[GAP: covered for chat paste only; not asserted across settings/search/rename fields]`
- [ ] Injection-ish strings (`</script>`, `{{7*7}}`, `${x}`, SQL-ish) in name/search/note fields are escaped, never executed/interpolated `[GAP]`
- [ ] Negative / NaN / Infinity into numeric inputs (sliders, RPC ports, temperature) clamp to valid range, never persist NaN `[GAP]`
- [ ] Rapid random interleaving of nav + send + toggle + background across the whole app leaves a valid, reloadable state (property: reload after fuzz still boots) `[GAP: per-surface fuzz exists (overlay); no whole-app interleave harness]`
- [ ] Double-submit any form (send, save settings, download, connect) issues exactly one network request / one row (idempotency) `[PARTIAL: launcher-interaction + settings-sections specs click controls; dedupe/no-dup-request not universally asserted]`
- [ ] Property — no interaction sequence produces a latched/never-clearing spinner (every loading state has a terminal transition) `[GAP: asserted implicitly per-view via clicksafe, not as a global invariant]`
- [ ] Property — no interaction leaves an orange→black or blue hover; brand accent rules hold after any state change `[COVERED: test/ui-smoke/all-views-aesthetic-audit.spec.ts + aesthetic-audit-rules.ts]`
- [ ] axe pass after a representative fuzz sequence on each major surface `[PARTIAL: aesthetic/interaction specs; no post-fuzz axe assertion]`
- [ ] Keyboard-only traversal (Tab/Shift-Tab/Enter/Escape) can reach + operate every primary control on every view `[PARTIAL: all-pages-clicksafe covers click-safety, not full keyboard traversal]`

---

## Coverage summary

| View / Surface | Existing test path(s) | Biggest gap |
|---|---|---|
| Global view-switching & tab storms | test/ui-smoke/view-switching-core-matrix.spec.ts; view-switching-core-matrix-coverage.test.ts; core-view-interaction-coverage.test.ts; view-interaction-coverage.test.ts | No burst-storm (switch without settle) + no whole-app seeded random-walk; mid-load cancellation unasserted |
| Browser history (back/forward) | test/ui-smoke/history-navigation.spec.ts; titlebar-navigation.spec.ts; mobile-lifecycle.test.ts (back-button) | Only 3 routes in history stack; no deep back-stack across all tabs; back-mid-load cancellation |
| Deep-link cold-load (every route) | test/ui-smoke/all-pages-clicksafe.spec.ts; route-coverage.test.ts | No 404/unknown-route fallback test; no corrupt-localStorage recovery; no cold-load-while-offline |
| Orientation change | none (only aesthetic-audit references orientation) | ENTIRELY UNCOVERED — no functional portrait↔landscape rotation test on any view/modal |
| App background / resume | test/mobile-lifecycle.test.ts; background-runner.test.ts | Background-mid-stream resume + draft restore not asserted |
| Connection loss & recovery | mobile-lifecycle.test.ts (network event); ConnectionFailedBanner.stories.tsx (component) | No e2e forces failed/reconnecting state → Retry/Restart idempotency + recover-without-reload untested; multi-client-desync + multi-window-sync are test.skip |
| Memory-prune on background | test/ui-smoke/chat-view-memory-stability.spec.ts | Heap bounded only over chat-route cycle; prune-then-rebuild data integrity + all-tab listener flatness unasserted |
| Error-boundary recovery | StartupFailureView.test.tsx; warming-shell-startup.spec.ts; reset-returns-to-onboarding.spec.ts | ErrorBoundary itself has no throw-then-recover test; per-widget/per-view crash isolation untested |
| Kiosk & shell-mode transitions | readShellMode() logic (App.tsx); indirect refs in voice/assistant specs | KioskViewCanvas has zero tests (iframe sandbox lock, floating drag); no shellMode= boot e2e for any of the 8 modes; top-nav-lock security invariant untested |
| Overlay surfaces | ContinuousChatOverlay.fuzz.test.tsx (extensive); chat-overlay-controls-interactions.spec.ts; NotificationCenter.test.tsx; slash-commands.spec.ts | HomePill/AssistantOverlay have no co-located tests; overlay-during-view-switch z-order fuzz |
| Cross-cutting adversarial fuzz | chat-large-paste.spec.ts; all-views-aesthetic-audit.spec.ts; ContinuousChatOverlay.fuzz.test.tsx | No whole-app interleave/property harness; emoji/RTL/injection/NaN fuzz not applied across non-chat fields; global "no latched spinner" + post-fuzz axe invariants |

**Single biggest gap:** Orientation change is entirely uncovered by any functional test (only referenced in the aesthetic screenshot audit), and connection-loss recovery has no e2e at all — the two cross-client/window sync specs that would prove recovery (`multi-client-desync.spec.ts`, `multi-window-sync.spec.ts`) are both `test.skip` because the ui-smoke mock layer has no shared backing store, so the entire "lose the connection, recover, converge" story is unverified end-to-end.
