# Launch Readiness 09: Desktop QA

## Second-Pass Status (2026-05-05)

- Current: the core desktop runtime-mode risks remain accurate, including disabled/manual-mode UX coverage and local/runtime persistence divergence.
- Still open: packaged Electrobun Playwright regressions are not exposed by a package script, release CI references missing heavy/desktop scripts, and `test-electrobun-release.yml` still contains intentional no-op porting checks.
- Launch gate: desktop work is not fully automated; add real packaged Playwright scripts and wire release CI before treating desktop launch validation as complete.

## Current state

The desktop app is an Electrobun shell around the app-core renderer. The shell owns the main window, tray/menu behavior, detached surfaces, native OS permission bridges, auth/session bridges, and an optional embedded app-core runtime child process.

Runtime support is present for local embedded runtime, external API mode, and disabled/manual mode. The onboarding/runtime picker exposes cloud, local, and remote choices on desktop/dev builds, with cloud provisioning, local runtime startup, and remote/manual API connection flows. Restore logic can reconnect to persisted cloud, remote, or local targets, and can probe loopback when no active server is saved.

Local model support is substantial in code: there is a GGUF catalog, download/install state, active model management, provider routing, a node-llama-cpp engine path, device bridge support, and REST/SSE compatibility routes. I did not validate actual model download or inference in this pass.

Packaging/runtime configuration is present for macOS, Windows, and Linux. The config copies renderer and runtime assets into the packaged app, wires WebGPU/CEF settings, and includes macOS signing/notarization/entitlements configuration. Release docs exist, but the desktop release checklist remains sparse and still relies on human OS/hardware coverage.

## Evidence reviewed with file refs

- Root and package scripts: `package.json:20-24`, `packages/app/package.json:5-27`, `packages/app/package.json:54-73`, `packages/app-core/platforms/electrobun/package.json:5-14`.
- Electrobun packaging/runtime config: `packages/app-core/platforms/electrobun/electrobun.config.ts:8-80`, `packages/app-core/platforms/electrobun/electrobun.config.ts:107-253`.
- Desktop runtime mode/API selection: `packages/app-core/platforms/electrobun/src/api-base.ts:4-17`, `packages/app-core/platforms/electrobun/src/api-base.ts:72-140`, `packages/app-core/platforms/electrobun/src/api-base.ts:143-166`.
- Desktop shell startup and runtime orchestration: `packages/app-core/platforms/electrobun/src/index.ts:1012-1125`, `packages/app-core/platforms/electrobun/src/index.ts:1441-1660`, `packages/app-core/platforms/electrobun/src/index.ts:2077-2387`.
- Embedded runtime manager: `packages/app-core/platforms/electrobun/src/native/agent.ts:1-25`, `packages/app-core/platforms/electrobun/src/native/agent.ts:545-763`, `packages/app-core/platforms/electrobun/src/native/agent.ts:1068-1464`, `packages/app-core/platforms/electrobun/src/native/agent.ts:1533-1567`.
- Main window session/runtime test hooks: `packages/app-core/platforms/electrobun/src/main-window-session.ts:1-74`.
- Runtime picker and startup restore: `packages/app-core/src/components/shell/RuntimeGate.tsx:120-133`, `packages/app-core/src/components/shell/RuntimeGate.tsx:396-472`, `packages/app-core/src/components/shell/RuntimeGate.tsx:560-680`, `packages/app-core/src/components/shell/RuntimeGate.tsx:824-830`, `packages/app-core/src/components/shell/RuntimeGate.tsx:991-1089`, `packages/app-core/src/state/startup-phase-restore.ts:50-75`, `packages/app-core/src/state/startup-phase-restore.ts:113-205`, `packages/app-core/src/state/persistence.ts:794-920`.
- Full onboarding callbacks: `packages/app-core/src/state/useOnboardingCallbacks.ts:430-704`.
- Local inference/model stack: `packages/app-core/src/services/local-inference/catalog.ts:1-163`, `packages/app-core/src/services/local-inference/service.ts:44-195`, `packages/app-core/src/services/local-inference/engine.ts:1-17`, `packages/app-core/src/services/local-inference/engine.ts:80-214`, `packages/app-core/src/services/local-inference/active-model.ts:1-144`, `packages/app-core/src/services/local-inference/providers.ts:82-139`, `packages/app-core/src/services/local-inference/providers.ts:218-240`, `packages/app-core/src/services/local-inference/router-handler.ts:1-198`, `packages/app-core/src/runtime/ensure-local-inference-handler.ts:1-20`, `packages/app-core/src/runtime/ensure-local-inference-handler.ts:70-187`, `packages/app-core/src/runtime/ensure-local-inference-handler.ts:318-471`, `packages/app-core/src/api/local-inference-compat-routes.ts:1-12`, `packages/app-core/src/api/local-inference-compat-routes.ts:107-605`.
- Desktop permissions: `packages/app-core/platforms/electrobun/src/native/permissions-shared.ts:22-82`, `packages/app-core/platforms/electrobun/src/native/permissions.ts:20-177`, `packages/app-core/platforms/electrobun/src/native/permissions-darwin.ts:35-342`, `packages/app-core/platforms/electrobun/src/native/permissions-win32.ts:6-55`, `packages/app-core/platforms/electrobun/src/native/permissions-linux.ts:6-34`, `packages/app-core/src/platform/desktop-permissions-client.ts:15-162`, `packages/app-core/platforms/electrobun/src/runtime-permissions.ts:8-117`.
- Desktop docs and release checklist: `docs/apps/desktop.md:7-8`, `docs/apps/desktop.md:43-45`, `docs/apps/desktop.md:89-133`, `docs/apps/desktop.md:159-202`, `docs/apps/desktop/release-regression-checklist.md:1-12`.
- Packaged desktop regression tests: `packages/app/test/electrobun-packaged/electrobun-packaged-regressions.e2e.spec.ts:762-858`, `packages/app/test/electrobun-packaged/electrobun-packaged-regressions.e2e.spec.ts:875-1088`.

## What I could validate

- Static review confirmed desktop packaging, runtime startup, shell, permission, cloud/local/remote picker, and local inference code paths exist and are wired together.
- Targeted Electrobun tests passed:
  - Command: `bunx vitest run --config vitest.electrobun.config.ts src/electrobun-config-root.test.ts src/main-window-session.test.ts src/native/agent.test.ts src/native/auth-bridge.test.ts src/application-menu.test.ts src/surface-windows.test.ts`
  - Result: 6 test files passed, 30 tests passed.
- Targeted app-core runtime/local inference tests passed:
  - Command: `bunx vitest run --config vitest.config.ts src/runtime/ensure-local-inference-handler.test.ts src/services/local-inference/router-handler.test.ts src/services/local-inference/providers.test.ts src/services/local-inference/device-bridge.test.ts src/api/local-inference-compat-routes.test.ts src/components/shell/RuntimeGate.test.tsx`
  - Result: 6 test files passed, 54 tests passed. Only observed warning was Node's experimental SQLite warning.
- Electrobun typecheck passed:
  - Command: `bun run typecheck`
  - Result: `tsc --noEmit` completed successfully.

## What I could not validate

- I did not build, sign, notarize, or install packaged macOS/Windows/Linux artifacts.
- I did not launch a packaged GUI app or run the packaged Playwright regression suite because it requires a packaged launcher and heavier OS/UI coverage.
- I did not exercise real macOS TCC prompts, Windows privacy settings, Linux desktop permission behavior, tray/menu behavior, detached windows, deep links, or window persistence in a live desktop session.
- I did not test real Eliza Cloud auth/provisioning, OAuth/deep-link return, or multiple-cloud-agent selection.
- I did not download, verify, activate, or run generation through a real GGUF model or `node-llama-cpp` binding.
- I did not verify current availability of catalog model URLs or Hugging Face assets.
- I did not run upgrade, crash recovery, missing runtime bundle, or first-launch cold boot scenarios end to end.

## Bugs/risks P0-P3

### P0

- None found in this bounded review.

### P1

- Desktop local selection in `RuntimeGate` clears `elizaos:active-server` instead of persisting a local active server (`packages/app-core/src/components/shell/RuntimeGate.tsx:439-472`). The full onboarding callback path does persist local (`packages/app-core/src/state/useOnboardingCallbacks.ts:625-665`). Relaunch restore can still probe loopback, but this split increases risk of onboarding/session drift if the embedded runtime is slow or unavailable during restore.
- Windows embedded runtime disables local embeddings in the child environment (`packages/app-core/platforms/electrobun/src/native/agent.ts:1249-1253`). That may be correct for crash avoidance, but it means "all-local" needs explicit Windows QA and product copy must avoid overpromising local embeddings on Windows.

### P2

- Disabled/manual mode is implemented in runtime selection but appears under-covered by UX and tests. `resolveInitialApiBase` falls back to loopback for disabled mode (`packages/app-core/platforms/electrobun/src/api-base.ts:87-97`), while startup intentionally skips the embedded runtime unless mode is local (`packages/app-core/platforms/electrobun/src/index.ts:1618-1623`, `packages/app-core/platforms/electrobun/src/index.ts:2373-2386`). Manual QA should verify the error, recovery, and connect-server path when no server is running.
- Desktop permissions are platform-best-effort. macOS has the richest implementation, Windows returns mostly `not-determined` or `not-applicable`, and Linux returns several permissions as granted without real privacy prompts (`packages/app-core/platforms/electrobun/src/native/permissions-win32.ts:6-55`, `packages/app-core/platforms/electrobun/src/native/permissions-linux.ts:6-34`). Release QA needs platform-specific expectation checks.
- Packaged regression tests include a fallback when localStorage did not persist across relaunch (`packages/app/test/electrobun-packaged/electrobun-packaged-regressions.e2e.spec.ts:814-858`). The fallback is useful, but the underlying persistence behavior should be watched in real packaged builds.
- Local inference is well covered structurally, but real model download/load/generate remains unvalidated here. GPU, memory pressure, native binding load, and large-file storage permissions remain release risks.
- Cloud runtime auto-connects to the first listed cloud agent or auto-creates one (`packages/app-core/src/components/shell/RuntimeGate.tsx:616-680`). Accounts with multiple agents need manual QA to confirm the chosen behavior is acceptable.

### P3

- Desktop docs say the child runtime receives `ELIZA_PORT` (`docs/apps/desktop.md:112-116`), but the runtime manager sets and then deletes `ELIZA_PORT`, leaving `ELIZA_API_PORT` in the child environment (`packages/app-core/platforms/electrobun/src/native/agent.ts:1237-1247`). This is likely docs drift or compatibility cleanup, but it should be aligned.
- The desktop release checklist is still very small (`docs/apps/desktop/release-regression-checklist.md:1-12`) compared with the number of platform/runtime/model combinations that need manual coverage.

## Codex-fixable work

- Persist a local active server when desktop local mode is chosen from `RuntimeGate`, or document why probing is intentional, then add a relaunch/restore unit test.
- Add targeted tests for disabled/manual desktop mode API-base behavior and renderer recovery messaging.
- Align `docs/apps/desktop.md` with the actual child runtime port environment (`ELIZA_API_PORT` vs `ELIZA_PORT`).
- Add explicit Windows copy/status for local embeddings being disabled in the embedded runtime.
- Add permission status tests or snapshot expectations for macOS, Windows, and Linux stubbed behavior.
- Add a single documented `desktop:smoke` script that builds or locates a packaged launcher, starts the app with test API settings, and runs the packaged regression suite.
- Expand `docs/apps/desktop/release-regression-checklist.md` into the matrix below or link to a fuller desktop launch QA checklist.

## Human desktop QA matrix

| Area | macOS | Windows | Linux | Expected |
| --- | --- | --- | --- | --- |
| Install/package | DMG/ZIP install, Gatekeeper, notarization, arm64/x64 if shipped | Installer/portable launch, SmartScreen/signature, x64/arm64 if shipped | AppImage/deb launch, sandbox/library dependencies | App opens without security blocks or missing native assets. |
| First launch all-local | No cloud session, choose local | No cloud session, choose local | No cloud session, choose local | Embedded runtime starts, health becomes ready, app reaches usable shell without onboarding loop. |
| First launch all-cloud | Cloud auth and deep-link return | Cloud auth and deep-link return | Cloud auth and deep-link return | Cloud agent connects or provisions, state persists after quit/relaunch. |
| External API mode | Set `ELIZA_DESKTOP_API_BASE` | Set `ELIZA_DESKTOP_API_BASE` | Set `ELIZA_DESKTOP_API_BASE` | Embedded runtime does not start; renderer uses external API and recovers on disconnect/reconnect. |
| Disabled/manual mode | Set `ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT=1` | Set same | Set same | Clear offline/manual-server behavior when no local server is running; recovery works after server starts. |
| Local models | Catalog, download, cancel, verify, activate, tiny GGUF generation | Same, plus Windows embedding limitation | Same, plus CPU/GPU fallback | Model lifecycle works and failures produce actionable UI/log messages. |
| Device bridge | Enable bridge and connect/disconnect | Enable bridge and connect/disconnect | Enable bridge and connect/disconnect | Device provider appears, routes correctly, and falls back cleanly. |
| App shell | Tray, dock/menu, close-to-tray, detached windows, external links | Tray/menu, close-to-tray, detached windows, external links | Tray/menu where supported, detached windows, external links | Shell controls behave consistently and external navigation is blocked or opened safely. |
| Permissions | Accessibility, screen recording, mic, camera, website blocking, location | Mic/camera/settings links, not-applicable states | Stubbed/granted/not-applicable states | UI status matches OS behavior; settings buttons open the right OS page where supported. |
| Persistence/upgrade | Relaunch, reset app data, upgrade older build | Relaunch, reset app data, upgrade older build | Relaunch, reset app data, upgrade older build | Active runtime, auth/session, window state, provider settings, and local models persist unless reset. |
| Crash/recovery | Kill child runtime, corrupt/missing runtime dist, port conflict | Same, plus process cleanup | Same | App reports failure, logs enough context, and reset/retry paths recover. |
| Power/GPU/windowing | WebGPU/CEF, battery, sleep/wake, resize/vibrancy | WebGPU/CEF, sleep/wake, resize | WebGPU/CEF flags, compositor differences | No blank canvas, runaway CPU/GPU, or broken layout after resume/resize. |

## AI QA Pass 2026-05-11 (static analysis)

Workstream 4 of the AI QA master plan (`23-ai-qa-master-plan.md`). This is a **static code audit** of every desktop-specific surface. Live device runs were blocked, so findings are sourced from reading the code and confirming wiring (or the absence of it). Each finding cites file:line.

### 1. Native titlebar (mac traffic-light padding, drag region, Windows/Linux behavior)

The macOS shell uses `titleBarStyle: "hiddenInset"` (`packages/app-core/platforms/electrobun/src/index.ts:881-882`, `:944,984`) and overlays a custom header in the renderer. The header reserves space for the traffic lights via the `--eliza-macos-frame-left-inset: 80px` CSS variable (`packages/ui/src/styles/electrobun-mac-window-drag.css:21`) and a `MAC_TITLEBAR_PADDING_STYLE` constant (`packages/ui/src/components/shell/Header.tsx:76-82`). Drag/no-drag regions are driven by `[data-window-titlebar]`, `[data-window-titlebar-drag-zone]`, and `[data-no-camera-drag]` data attributes in conjunction with CSS rules at `electrobun-mac-window-drag.css:33-46,67-100`.

- **[P2] Hard-coded 80px traffic-light inset, brittle across macOS versions.** `packages/ui/src/styles/electrobun-mac-window-drag.css:21` and `packages/ui/src/components/shell/Header.tsx:78` both fall back to `80px` when Electrobun has not populated the CSS variable. macOS Sequoia 15+ uses traffic lights ~78px wide; macOS 12 used ~72px. A hard-coded value can clip the leftmost nav tab on a high-density display when the system width changes. Recommend driving from a measured value the host posts via RPC, with the literal 80 only as a last resort.
- **[P2] No Windows/Linux titlebar handling at all in Header.tsx.** `packages/ui/src/components/shell/Header.tsx:93-101` only branches on macOS (`shouldShowMacDesktopTitleBar`). Windows and Linux fall through to `titleBarStyle: "default"` (`packages/app-core/platforms/electrobun/src/index.ts:882,984`), which is the OS-native title bar. That's fine functionally, but the QA matrix in this doc line 102 still references "Tray/menu, close-to-tray, detached windows" for both Windows and Linux. There is **no close-to-tray behavior anywhere** (search for `closeToTray`, `hideOnClose`, `will-close` in `packages/app-core/platforms/electrobun/src/` returns nothing). Either the QA matrix is wrong or the close-to-tray behavior is not implemented.
- **[P3] Stray dependency on `windowShellRoute` at module init.** `packages/app/src/main.tsx:209` resolves `windowShellRoute` once at module load (`resolveWindowShellRoute()`) and reuses it. If the URL hash changes during the same session (e.g. navigating between detached and main shells in the same window — possible via `syncDetachedShellLocation`), the module-scoped `windowShellRoute` won't update. Not currently a bug because detached and main shells live in different OS windows, but it's fragile.
- **[P3] `transparent: process.platform === "darwin"` (`packages/app-core/platforms/electrobun/src/index.ts:883,985`) means Windows/Linux windows are fully opaque.** Vibrancy / acrylic backdrops are explicitly Mac-only. Confirmed expected by `applyMacOSWindowEffects(win)` at `:950` being the only place that activates them.

### 2. Tray menu items

The renderer-side menu is defined in `packages/ui/src/desktop-runtime/DesktopTrayRuntime.tsx:19-33` (`DESKTOP_TRAY_MENU_ITEMS`) — 11 items including 3 separators. Tray clicks are routed via the Electrobun RPC `desktopTrayMenuClick` channel (`DesktopTrayRuntime.tsx:166-188` for menu-reset, `DesktopTrayRuntime.tsx:226-296` for tray actions). `packages/app/src/main.tsx:614-623` ALSO registers the same tray menu via the Capacitor `Desktop.setTrayMenu` + `Desktop.addListener('trayMenuClick', ...)` API.

The host-side tray is configured separately at `packages/app-core/platforms/electrobun/src/index.ts:2196-2226`. That tray has a **completely different set of items** (Show Window, per-app entries, Start/Stop Agent, Restart Agent, Quit) and dispatches via `"tray-clicked"` Electrobun events handled at `:1751-1759`.

- **[P0] `Desktop.addListener("trayMenuClick", ...)` in `packages/app/src/main.tsx:618-623` is dead code.** The Capacitor `Desktop` plugin's `addListener` (`packages/app/node_modules/@elizaos/capacitor-desktop/src/web.ts:428-464`) only special-cases `windowFocus`/`windowBlur` and stores all other listeners in an array that `notifyListeners` is **never called for** (the only `notifyListeners` invocation at `:308` is for browser notifications). The registration silently succeeds, but the listener never fires. Tray actions still work because `DesktopTrayRuntime.tsx:165-188` and `DesktopSurfaceNavigationRuntime.tsx:18-46` subscribe directly to the RPC channel — but the layered registration in `main.tsx` is misleading and must be removed or wired through `notifyListeners`.
- **[P0] Two competing tray menu definitions ship in the same build.** The renderer registers the menu defined in `DesktopTrayRuntime.tsx:19-33` via `Desktop.setTrayMenu`. The host-side `index.ts:2196-2226` builds and registers its OWN menu (`Tray = new Tray({...})`) at startup with different items: per-app entries, "Show Window", "Start/Stop Agent", etc. Only ONE of these is visible to the user — and since the renderer's `setTrayMenu` call happens after the host registers its tray, the renderer's menu likely wins (or they collide). The two menus must be reconciled to a single source of truth.
- **[P1] `quit` tray item has no handler in `DesktopTrayRuntime.tsx`'s switch.** `DesktopTrayRuntime.tsx:242-291` covers tray-open-chat/plugins/etc but not `quit`. Quit only works because the host-side handler at `packages/app-core/platforms/electrobun/src/native/desktop.ts:717-721` catches `action === "quit"` from the native tray-clicked event. If `setTrayMenu` is the active path, the `quit` item dispatches to the renderer's `handleTrayAction` which hits the `default: return;` branch (line 290) — quit becomes a no-op. Confirmed in code; requires live verification.
- **[P2] Tray click audit metadata vs. handler drift.** `DESKTOP_TRAY_CLICK_AUDIT` at `DesktopTrayRuntime.tsx:35-118` lists every tray item with `coverage: "automated"` except `quit` (`coverage: "manual"`). No automated test in `packages/app/test/` or `packages/app-core/platforms/electrobun/src/` actually exercises the tray menu. The audit metadata claims more coverage than exists.
- **[P3] Separator IDs (`tray-sep-0`, `tray-sep-1`, `tray-sep-2`) are visible in the action payload.** If a user (or a future shortcut) ever dispatches `tray-sep-0` as an itemId, it hits the `default: return;` branch silently. Cheap to filter at registration time.

### 3. Global shortcuts (Cmd+K command palette)

`Desktop.registerShortcut({ id: "command-palette", accelerator: "CommandOrControl+K" })` at `packages/app/src/main.tsx:603-606`. The host registers via `GlobalShortcut.register(...)` at `packages/app-core/platforms/electrobun/src/native/desktop.ts:783-794` and sends `desktopShortcutPressed` to the renderer at `:785`. The renderer is supposed to receive that and dispatch `COMMAND_PALETTE_EVENT`.

- **[P0] Cmd+K from a globally-focused shortcut is broken — no renderer subscriber for `desktopShortcutPressed`.** A grep of `packages/ui/src/`, `packages/app-core/src/`, `packages/app/src/` for `desktopShortcutPressed` returns ZERO subscribers in source code (the only match is the host-side `send()` call at `native/desktop.ts:785` and a doc snippet at `packages/docs/apps/desktop/native-modules.md:415`). The path that registers the listener via `Desktop.addListener("shortcutPressed", ...)` at `packages/app/src/main.tsx:608-612` is dead for the same reason as the tray (see Section 2 P0 finding). Cmd+K only works because `CommandPalette.tsx:131-144` has a generic `keydown` listener — but that ONLY fires when the renderer has focus. Global hotkey behavior (Cmd+K from another app) is non-functional.
- **[P1] `Desktop.registerShortcut` return value is ignored.** `packages/app/src/main.tsx:603-606` awaits the call but never inspects `{ success: boolean }`. If `Cmd+K` is already taken by another app (Spotlight, Alfred, etc.), `GlobalShortcut.register(...)` throws and `desktop.ts:792-794` swallows it returning `{ success: false }`. User has no signal that the shortcut isn't registered.
- **[P2] Shortcut collision check absent.** No code calls `isShortcutRegistered({ accelerator: "CommandOrControl+K" })` (`desktop.ts:810-814`) before registering. macOS often has `Cmd+K` mapped to "Clear" / "Clear Display" / Slack's quick switcher / Chrome's "Search Engines" — a colliding registration may fail silently per the above finding.
- **[P3] Only one global shortcut is registered.** Other natural candidates (toggle window with Cmd+Shift+I or similar, toggle voice with Cmd+Shift+V) are absent. Power users may expect more.

### 4. Detached windows (`openDesktopSettingsWindow`, `openDesktopSurfaceWindow`, `DetachedShellRoot`)

`packages/ui/src/utils/desktop-workspace.ts:162-186` exposes two open-window helpers that call RPCs (`desktopOpenSettingsWindow`, `desktopOpenSurfaceWindow`). The detached shell renderer is `packages/ui/src/desktop-runtime/DetachedShellRoot.tsx:217-258`, which switches on `target.tab` (browser, chat, plugins, triggers, settings).

- **[P1] Detached shell hard-imports `BrowserWorkspaceView` lazy chunk only — `ChatView`, `PluginsPageView`, `HeartbeatsView`, `CloudDashboard`, `ProviderSwitcher`, `VoiceConfigView`, `PermissionsSection`, `ReleaseCenterView`, `CodingAgentSettingsSection` are all eagerly imported (`DetachedShellRoot.tsx:9-26`).** A detached settings window for "voice controls" loads the entire chat + plugin + heartbeats bundle. Cold reload of a small settings popup loads megabytes of unrelated code. Either split via `lazy()` consistently or accept this is a single bundle by design.
- **[P2] No window-state persistence for detached windows.** Searching `packages/app-core/platforms/electrobun/src/` for `detached.*bounds` / `detached.*state` returns no save-restore logic for the small popup windows. Closing and reopening always starts at the host's default size; users repositioning a detached chat window get no memory of that position. Verifiable in code; impact is UX-level.
- **[P2] Detached shell theme load on first mount only.** `packages/app/src/main.tsx:988` calls `applyStoredDetachedShellTheme()` once when the shell route is detached. If the main window changes the theme afterward, detached windows do NOT pick up the change — there's no event subscription on the detached side. Confirm via comparison with the main shell which DOES listen via `syncBrandEnvToEliza` and theme events.
- **[P2] Listener leak risk in `DesktopTrayRuntime.tsx:163-212`'s retry loop.** The exponential-backoff `schedulePoll()` keeps re-running `setTimeout` until cancelled. The `cancelled` boolean is checked twice per cycle, but `attach()` re-creates the subscribe call each time — if the prior `unsubscribe` reference becomes stale, a subscribe → unsubscribe sequence on rapid mount/unmount could leak. Combined with the unconditional `pollMs = Math.min(pollMs * 1.5, MAX_POLL_MS);` line: if `attach()` returns `true` on its first call, the polling never starts (correct). If it starts polling and the component unmounts mid-poll, the active `setTimeout` is cleared but the inner promise resolution is not. Tighten.

### 5. Share target (drop / share handler)

`packages/app/src/main.tsx:316-338` builds a window-level share queue (`__ELIZA_APP_SHARE_QUEUE__`), `dispatchShareTarget` pushes to it and dispatches `SHARE_TARGET_EVENT`. `main.tsx:625-635` subscribes to the host's `shareTargetReceived` IPC and routes to `handleDeepLink`. The deep-link handler at `:550-575` dispatches a `SHARE_TARGET_EVENT` when the deep link is `eliza://share?...`.

- **[P0] `SHARE_TARGET_EVENT` has no renderer listeners.** A grep across `packages/ui/src/`, `packages/app-core/src/`, `packages/app/src/` for `addEventListener.*share-target` or `SHARE_TARGET_EVENT,` returns ZERO listeners outside of `events/index.ts` (the constant definition) and `packages/app/src/main.tsx:337` (the dispatcher). The queue at `window.__ELIZA_APP_SHARE_QUEUE__` is also never drained. When a user invokes the share target, the event fires and disappears — nothing happens. The docs at `packages/docs/apps/desktop/deep-linking.md:40-45` reference a fictional `attachToCurrentConversation` function that doesn't exist anywhere. **Shipping the share target without a consumer means it does nothing user-visible.**
- **[P1] Share queue grows unbounded.** `packages/app/src/main.tsx:316-333` calls `getShareQueue().push(payload)` on every share but no code drains it. Memory leak risk if a user repeatedly shares to a deep-linkable URL while the app is open.
- **[P2] No handling for "no chat open" case.** Even if a consumer existed, the docs say the payload goes "to the current conversation" — but if the user is on Settings or Apps, no conversation is active. Spec missing.
- **[P3] Deep-link `eliza://share` is validated but the share-target IPC path is not.** `main.tsx:625-635` accepts any string `url` from the host IPC without re-validating it goes through the `eliza:` scheme or the share host. Currently OK because `handleDeepLink` parses with `new URL(...)` and rejects non-matching protocols at `:474`, but a future change could break that.

### 6. Desktop dev observability endpoints

`packages/app-core/src/api/dev-compat-routes.ts:28-211` mounts five routes under `/api/dev/...`. All gate on `isLoopbackRemoteAddress(req.socket.remoteAddress)` and `ensureRouteAuthorized(req, res, state)`. All return 404 in production via `process.env.NODE_ENV === "production"` (`:41-44`).

- **[P0 — confirmed safe] SSRF guard on `cursor-screenshot` upstream URL is correct.** `dev-compat-routes.ts:96-111` parses `ELIZA_ELECTROBUN_SCREENSHOT_URL` and rejects any hostname that is not `127.0.0.1`, `localhost`, `[::1]`, or `::1`. `redirect: "error"` is set on the fetch. No additional issues found here.
- **[P0 — confirmed safe] `console-log` path allowlist is correct.** `packages/app-core/src/api/dev-console-log.ts:18-24` requires the file basename be exactly `desktop-dev-console.log` AND that the path contains a `.eliza` segment. Reading is bounded by `ABS_CAP_BYTES=2_000_000` and `ABS_CAP_LINES=5000` (`:31-33`). Good defense-in-depth.
- **[P1] `dev-stack` endpoint exposes `desktopApiBase` from env without re-validation.** `dev-compat-routes.ts:55-62` returns `ELIZA_DESKTOP_API_BASE` verbatim. If an attacker can poison env (e.g., dev pairing flow) and pivot via `/api/dev/stack`, they can advertise an external host. Loopback gate + auth check mitigate this for unprivileged callers, but the call is still on the trust boundary. Document the assumption that env is trusted on loopback.
- **[P2] `voice-latency` and `route-catalog` routes inherit the same guards as the others — confirmed safe.** `dev-compat-routes.ts:65-76,186-208` repeat the loopback + auth gates. Consistent.
- **[P2] Loopback check delegates to `isLoopbackRemoteAddress` in `compat-route-shared`.** Should double-check that function handles IPv4-mapped IPv6 addresses (`::ffff:127.0.0.1`) — many Node servers receive that form. Worth a unit test if not already covered.
- **[P3] `cursor-screenshot` does not cap response size.** A pathological upstream could spam a huge PNG; we fetch and buffer the whole `arrayBuffer()` before sending. Loopback-only mitigates but a content-length check would be cheap.

### 7. Auto-update flow

`packages/app-core/platforms/electrobun/src/index.ts:1520-1597` defines `setupUpdater()`. `getUpdaterAvailability()` at `packages/app-core/platforms/electrobun/src/native/desktop.ts:2205-2257` gates auto-update.

- **[P1] No dev-mode skip on Windows / Linux.** `desktop.ts:2210-2216` returns `canAutoUpdate: true` unconditionally on non-macOS platforms. Only macOS checks `inApplications`. On Windows or Linux, even a development build (`ELECTROBUN_DEV=1`, `NODE_ENV !== production`) will hit `Updater.checkForUpdate()` and `Updater.downloadUpdate()` at `index.ts:1539-1547`. A `process.env.ELECTROBUN_DEV` (or a new `ELIZA_DESKTOP_DISABLE_AUTO_UPDATE`) check is needed to opt unpackaged builds out.
- **[P1] No environment-variable kill switch.** No `ELIZA_DISABLE_AUTO_UPDATE`, `SKIP_UPDATE`, or similar found anywhere in `packages/app-core/platforms/electrobun/src/`. Operators in regulated environments cannot disable the updater without a code change. Compare with the documented `EXECUTECODE_DISABLE` pattern in CLAUDE.md.
- **[P2] `setupUpdater()` error path silently logs and moves on.** `index.ts:1555-1565` only logs to `logger.warn`. If `Updater.checkForUpdate()` repeatedly fails (e.g., update server down), no telemetry, no surfaced UI signal until the manual "Check for Updates" menu fires.
- **[P3] Manual check path always shows notification then immediately re-checks.** `index.ts:1589-1595` shows "Checking for Updates" notification then calls `runUpdateCheck(true)`. If the user spams the menu item, multiple update checks pile up. Cheap debounce missing.

### 8. Shutdown overlay

`packages/ui/src/App.tsx:889-897` subscribes to `desktopShutdownStarted` and toggles `desktopShuttingDown` state. The overlay renders at `App.tsx:1278-1293`. The host fires the event from `packages/app-core/platforms/electrobun/src/index.ts:1844` (`runShutdownCleanup`) and `packages/app-core/platforms/electrobun/src/native/desktop.ts:1426` (`beginAppExit`).

- **[P0 — confirmed correct] Trigger fires on the right signal.** `index.ts:1851-1855` registers `before-quit` to call `runShutdownCleanup("before-quit")` which calls `sendToActiveRenderer("desktopShutdownStarted", ...)` at `index.ts:1844`. `desktop.ts:1425-1428` also sends `desktopShutdownStarted` before quit and sleeps 150ms to let the renderer paint.
- **[P2] No timeout / fallback if the overlay never clears.** If shutdown stalls (e.g., a sync `cleanupFn` hangs in `runShutdownCleanup`), the overlay stays up forever. Cheap to add an `aria-live=polite` countdown or "if this takes more than X seconds, force-quit with Cmd+Q".
- **[P3] Overlay copy is hardcoded English.** `App.tsx:1286-1290` uses literal strings "Shutting down…" and "Closing services and saving state." instead of `t()`. Comparable English-only strings exist in `OnboardingBlockedView` (`DetachedShellRoot.tsx:151-158`) which DOES use `t()`. Inconsistency.

### 9. Per-platform branching

Cross-cutting `process.platform === "darwin" | "win32" | "linux"` checks. Surveyed via grep across `packages/app-core/platforms/electrobun/src/`.

- **[P1] Linux is treated as "not Windows, not macOS" everywhere it has any treatment at all.** `packages/app-core/platforms/electrobun/src/native/desktop.ts:1904-1923` (notification routing), `:2277-2284` (Linux uses CEF), `runtime-permissions.ts:43-45` (all three platforms ack'd but Linux returns stubs only — referenced in this doc's existing P2). The host menu definition (`application-menu.ts:208-256`) builds essentially identical Mac and non-Mac trees but Linux-specific concerns (Wayland vs X11, no global menu bar) are not addressed.
- **[P2] `process.platform === "darwin"` literal duplicated 30+ times.** Examples: `index.ts:137`, `:882`, `:883`, `:984`, `:985`, `:1228`, `desktop.ts:567`, `:586`, `:826`, `:843`. A single `IS_MAC` constant at module top would let the type-checker catch typos like `"darin"` and reduce churn for code that needs to handle a future renderer (CEF, etc.).
- **[P2] Linux tray menu support depends on `Tray = new Tray({...})` succeeding on GNOME 45+/KDE Plasma 6 — not verified.** `index.ts:2196-2226` wraps the tray creation in try/catch but only warns on failure. Many Linux desktop environments (GNOME without `gnome-shell-extension-appindicator`) drop the icon silently. Recommend a fallback that surfaces "Tray unavailable on this DE" in Settings → Desktop Workspace.
- **[P3] `transparent: process.platform === "darwin"` (`index.ts:883,985`) leaves Windows/Linux with opaque-only windows.** Tested vibrancy modes from `applyMacOSWindowEffects` are mac-only.
- **[P3] `process.platform === "win32"` short-circuits Windows-specific main-window CEF (`index.ts:887-889`).** Linux is implicitly treated like macOS for renderer selection.

### Summary

| Severity | Count | Notable findings |
|---|---|---|
| P0 | 4 | Cmd+K global hotkey broken (no `desktopShortcutPressed` subscriber); SHARE_TARGET_EVENT has no listeners; `Desktop.addListener` is dead code; two competing tray menu definitions ship in the same build |
| P1 | 8 | No dev-mode skip on auto-update Windows/Linux; no autoupdate kill-switch; share-queue unbounded; `quit` tray item has no renderer handler; detached shell eager-imports; `Desktop.registerShortcut` return ignored; `dev-stack` exposes env verbatim; Linux treated as "not Windows, not macOS" everywhere |
| P2 | 11 | Hard-coded 80px traffic-light inset; no Win/Linux titlebar handling in Header; tray click audit metadata drift; no window-state persistence for detached windows; detached theme load on mount only; listener leak risk in DesktopTrayRuntime retry loop; updater error path silent; shutdown overlay has no timeout; `voice-latency` / `route-catalog` consistency note; loopback check for IPv4-mapped IPv6; close-to-tray behavior absent vs. doc claims |
| P3 | 9 | Stray module-init `windowShellRoute` cache; opaque Win/Linux windows; manual update check has no debounce; shutdown overlay copy not localized; many `process.platform === "darwin"` literals; tray separator IDs leak into action payload; Cmd+K is the only global shortcut; cursor-screenshot has no response-size cap; deep-link IPC path not re-validated |

### Known live-only checks

These cannot be verified statically — they need a human (or computer-use MCP) on the actual built app:

- Tray icon visibility per OS (macOS menu bar, Windows system tray, Linux DE-dependent). Code wraps `new Tray(...)` in try/catch so failures are silent.
- Tray click → menu items fire (the renderer wiring is now suspect per Section 2 P0; live confirmation needed).
- Cmd+K from a non-focused state (global hotkey path is statically broken — confirm with live test).
- macOS traffic-light position when the host posts the actual inset (vs falling back to the hard-coded 80px).
- Detached settings window appearance, focus behavior, and screen positioning.
- Auto-update download and apply on a packaged installed bundle (only macOS in-`/Applications` is statically gated).
- Linux DE matrix: GNOME (Wayland), KDE Plasma (Wayland), XFCE (X11) — tray and Vibrancy fallbacks.
- WebGPU rendering on Windows / Linux (CEF fallback applied; live render still unverified).
- Share target round-trip from another macOS app via deep link, *if* a consumer is wired (currently none — see Section 5 P0).
- Visual confirmation that the "Shutting down…" overlay paints before the window closes.

## Changed paths

- `launchdocs/09-desktop-qa.md`
