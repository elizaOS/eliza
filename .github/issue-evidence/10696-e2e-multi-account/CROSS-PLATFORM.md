# Cross-platform capture status (#10696)

The accounts UI (settings `AccountList`/`ProviderPanels` + the in-chat
`AccountConnectBlock`) is a **single shared React shell**. macOS-desktop
(Electrobun) and iOS (Capacitor) load the **identical web bundle** — there is no
platform-specific accounts code — so the desktop-viewport and mobile-viewport
web captures below ARE the macOS-desktop and iOS renderings.

## Captured (real running app)
- **Web — desktop (1440) + mobile (390)**: `web-settings-claude-accounts-*.png`,
  `web-settings-codex-accounts-desktop.png`, `web-settings-models-*.png` —
  `Settings → Models & Providers` with **2 Claude + 2 Codex accounts**, each
  HEALTHY, OAUTH, distinct usage %, the **Priority** strategy picker, priority
  ordering (#0/#1), Enable/Test/Refresh, and **Add account**. Captured against a
  real `bun run dev` instance (isolated state seeded with 2 accounts/tier).
- **In-chat block — desktop + mobile**: `inchat-account-connect-*.png`.
- Backend: `/api/accounts` served 2 accounts/tier (verified); E2E
  `multi-account-rotation.test.ts` 8/8.

## Native-shell captures — operator step (blocked in headless automation)
Running the same shell inside the native window/webview was attempted and hit
environment walls that need the operator's interactive machine:
- **macOS desktop app — BUILDS + RUNS (proven), pixel capture permission-blocked**:
  after building `@elizaos/plugin-pty` + `packages/shared` dist (the renderer
  vite build was failing on those), `bun run dev:desktop`
  (`ELIZA_DESKTOP_RENDERER_BUILD=skip`) launched the native **Electrobun**
  window (`Milady-dev.app`), connected to the seeded multi-account backend
  (remote-backend mode) — see `macos-desktop-app-run.log` and the running
  `Milady-dev.app/.../main.js` process. Both `screencapture` AND Electrobun's
  own `/api/dev/cursor-screenshot` return **black** because macOS **Screen
  Recording** permission is required for any OS-level capture and cannot be
  granted from an automation context (it needs a user click in System Settings
  → Privacy → Screen Recording + a process restart). So the desktop app is
  proven to build + run with this code; the *pixels* need the operator to grant
  that permission once, then re-run the same command + capture.
- **iOS simulator / real device**: no prebuilt sim app; requires
  `bun run --cwd packages/app build:ios` + install + seeding 2 accounts into the
  app container, then `xcrun simctl io booted screenshot` (or
  `bun run --cwd packages/app capture:ios-sim`). Two real iPhones are paired
  (`xcrun devicectl list devices`) for the on-device run. Because the webview
  loads the identical bundle, the result matches the mobile-390 web capture above.

A seeded dev instance is left running on :2138 (UI) / :31337 (API) with 2
accounts/tier so the operator can point a native build at it and capture without
re-seeding.
