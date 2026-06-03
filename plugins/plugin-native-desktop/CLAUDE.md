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
  rollup.config.mjs   Builds IIFE (dist/plugin.js) and CJS (dist/plugin.cjs.js) from tsc output
  tsconfig.json
  package.json
```

## Commands

Scripts in package.json:

```bash
bun run --cwd plugins/plugin-native-desktop build    # clean + tsc + rollup
bun run --cwd plugins/plugin-native-desktop clean    # delete dist/
bun run --cwd plugins/plugin-native-desktop watch    # tsc --watch (no rollup)
# prepublishOnly runs build automatically before npm publish
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
- **Build pipeline:** `tsc` compiles to `dist/esm/`, then rollup bundles to `dist/plugin.js` (IIFE) and `dist/plugin.cjs.js` (CJS). The `build` script must be run before publishing; `watch` only runs tsc, not rollup.
- See root `AGENTS.md` for repo-wide architecture rules, logger conventions, and ESM standards.
