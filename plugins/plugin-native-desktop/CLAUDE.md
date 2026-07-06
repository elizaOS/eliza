# @elizaos/capacitor-desktop

Capacitor plugin that exposes desktop OS capabilities (system tray, global shortcuts, notifications, window management, clipboard, auto-launch, power monitor, and system permissions) to Eliza agent UIs running in Electrobun or a browser.

## Purpose / role

This is a **Capacitor plugin** (not an elizaOS Plugin-type action/provider). It provides the `Desktop` singleton that renderer code calls to drive native OS features via Electrobun's RPC bridge. On web/browser it falls back gracefully using Web APIs (Web Notifications, Clipboard API, Fullscreen API) or unavailable results. It is consumed by the agent desktop app UI — not registered as an elizaOS `Plugin` object.

Registration: `registerPlugin("Desktop", { web: loadWeb })` in `src/index.ts`. The Electrobun host implements the native side; `DesktopWeb` in `src/web.ts` covers the browser fallback.

## Plugin surface

This package exports a typed API object, not elizaOS actions/providers. The full interface is `DesktopPlugin` in `src/definitions.ts`. Grouped by area:

**System Tray** (`createTray`, `updateTray`, `destroyTray`, `setTrayMenu`) — create/manage a system tray icon with menu. Node only; unavailable return on web.

**Global Shortcuts** (`registerShortcut`, `unregisterShortcut`, `unregisterAllShortcuts`, `isShortcutRegistered`) — register OS-level keyboard accelerators. Node only; web returns `{ success: false }`.

**Auto Launch** (`setAutoLaunch`, `getAutoLaunchStatus`) — configure login-item / startup behavior. Node only; unavailable return on web.

**Window Management** (`setWindowOptions`, `getWindowBounds`, `setWindowBounds`, `minimizeWindow`, `maximizeWindow`, `unmaximizeWindow`, `closeWindow`, `showWindow`, `hideWindow`, `focusWindow`, `isWindowMaximized`, `isWindowMinimized`, `isWindowVisible`, `isWindowFocused`, `setAlwaysOnTop`, `setFullscreen`, `setOpacity`) — control the Electrobun window. Web fallbacks use `window.close()`, `window.focus()`, fullscreen API.

**Notifications** (`showNotification`, `closeNotification`) — show OS notifications. Node: Electrobun native; web: Web Notification API with permission prompt.

**Power Monitor** (`getPowerState`) — battery level, charging state, idle time/state. Web: Battery API where available.

**App** (`quit`, `relaunch`, `getVersion`, `isPackaged`, `getPath`) — app-level controls. `getPath` throws on web (filesystem paths unavailable).

**Clipboard** (`writeToClipboard`, `readFromClipboard`, `clearClipboard`) — text/HTML/RTF/image clipboard. Web: Clipboard API (text + HTML only).

**Shell** (`openExternal`, `showItemInFolder`, `beep`) — open URLs externally, reveal files in Finder/Explorer, system beep. Web: `window.open`; `showItemInFolder` reports unavailable.

**System Permissions** (`checkPermission`, `requestPermission`) — non-dialog probing of OS permissions via `DesktopPermissionId`. Delegates to the Electrobun host's prober registry (see `packages/agent/src/services/permissions/probers/`). Web covers `camera`, `microphone`, `location`, `notifications` via browser APIs; all others return `not-applicable`.

**Events** (via `addListener`) — `trayClick`, `trayDoubleClick`, `trayRightClick`, `trayMenuClick`, `shortcutPressed`, `notificationClick`, `notificationAction`, `notificationReply`, `windowFocus`, `windowBlur`, `windowMaximize`, `windowUnmaximize`, `windowMinimize`, `windowRestore`, `windowClose`, `powerSuspend`, `powerResume`, `powerOnAC`, `powerOnBattery`.

## Layout

```
plugins/plugin-native-desktop/
  src/
    index.ts          Entry: registerPlugin("Desktop", …) + re-exports from definitions
    definitions.ts    All TypeScript interfaces + DesktopPlugin interface
    web.ts            DesktopWeb — browser fallback implementation
    web.test.ts       Vitest tests for the web fallback
  rollup.config.mjs   Builds IIFE (dist/plugin.js) and CJS (dist/plugin.cjs.js) from tsc output
  tsconfig.json
  package.json
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-desktop clean           # remove build output
bun run --cwd plugins/plugin-native-desktop build           # build package artifacts
bun run --cwd plugins/plugin-native-desktop typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-desktop lint            # mutating Biome check
bun run --cwd plugins/plugin-native-desktop lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-desktop format          # write formatting
bun run --cwd plugins/plugin-native-desktop format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-desktop test            # run package tests
bun run --cwd plugins/plugin-native-desktop prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-desktop watch           # watch TypeScript sources
bun run --cwd plugins/plugin-native-desktop build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
```

## Config / env vars

None. This package reads no env vars and has no runtime configuration. All behavior is determined by which Capacitor platform implementation is active (Electrobun native vs. web fallback).

## How to extend

**Add a method to the plugin:**
1. Add the method signature to `DesktopPlugin` in `src/definitions.ts`.
2. Add the browser fallback implementation to `DesktopWeb` in `src/web.ts`.
3. The Electrobun host implementation lives in the consuming app's native plugin registration code (outside this package).
4. Re-export any new types from `src/index.ts` (it re-exports `./definitions` via `export *`).

**Add a new event:**
1. Add the overloaded `addListener` signature to `DesktopPlugin` in `src/definitions.ts` with the event name and listener type.
2. If the event has a browser equivalent, wire the `window` event listener in `DesktopWeb.addListener` (and remove it in `removeAllListeners`).

## Conventions / gotchas

- **npm name is `@elizaos/capacitor-desktop`**, not `@elizaos/plugin-native-desktop`. The directory name and the package name differ.
- **This is NOT an elizaOS `Plugin` object.** It does not register actions, providers, or services with `AgentRuntime`. It is a Capacitor plugin consumed by the UI layer.
- **Electrobun bridge:** The native side is wired by the host app via `window.__ELIZA_ELECTROBUN_RPC__`. The web fallback (`DesktopWeb`) first checks for this RPC bridge before falling back to Web APIs.
- **Platform availability:** System tray, global shortcuts, auto-launch, `getPath`, and `showItemInFolder` are Node/Electrobun only. Calling them on web returns unavailable results or throws. The `elizaos.platformDetails` field in `package.json` documents exactly what is available per platform.
- **`DesktopPermissionId`** mirrors `PermissionId` from `@elizaos/shared/contracts/permissions`. The type is defined inline here to keep this package free of cross-package type imports.
- **Build pipeline:** `tsc` compiles to `dist/esm/`, then rollup bundles to `dist/plugin.js` (IIFE) and `dist/plugin.cjs.js` (CJS). The `build` script uses `with-package-build-lock.mjs` to serialize concurrent builds; `build:unlocked` runs the actual steps. `watch` only runs tsc, not rollup.
- See root `AGENTS.md` for repo-wide architecture rules, logger conventions, and ESM standards.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
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

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
