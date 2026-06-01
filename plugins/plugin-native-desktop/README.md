# @elizaos/capacitor-desktop

Capacitor plugin that gives Eliza agent UIs access to native desktop OS capabilities. When running inside Electrobun it provides the full feature set; in a browser it falls back gracefully using Web APIs or safe no-ops.

## What it does

Adds the `Desktop` singleton to the renderer process with these capability groups:

| Capability | Node/Electrobun | Browser |
|---|---|---|
| System tray (icon, tooltip, menu) | Full | No-op |
| Global keyboard shortcuts | Full | No-op (`success: false`) |
| Auto-launch at login | Full | No-op |
| Window management (size, position, fullscreen, opacity, always-on-top) | Full | Partial (fullscreen, focus, close) |
| Native notifications | Full | Web Notification API |
| Power monitor (battery, idle state) | Full | Battery API where available |
| App controls (quit, relaunch, getPath, getVersion) | Full | Limited (`getPath` throws) |
| Clipboard (text, HTML, RTF, image) | Full | Text + HTML via Clipboard API |
| Shell (openExternal, showItemInFolder, beep) | Full | `window.open`; others no-op |
| System permissions (check/request) | Full via prober registry | camera, mic, location, notifications only |

## Events

Subscribe via `Desktop.addListener(eventName, listener)`:

- **Tray:** `trayClick`, `trayDoubleClick`, `trayRightClick`, `trayMenuClick`
- **Shortcuts:** `shortcutPressed`
- **Notifications:** `notificationClick`, `notificationAction`, `notificationReply`
- **Window:** `windowFocus`, `windowBlur`, `windowMaximize`, `windowUnmaximize`, `windowMinimize`, `windowRestore`, `windowClose`
- **Power:** `powerSuspend`, `powerResume`, `powerOnAC`, `powerOnBattery`

## Usage

```typescript
import { Desktop } from "@elizaos/capacitor-desktop";

// System tray
await Desktop.createTray({
  icon: "/path/to/icon.png",
  tooltip: "My Agent",
  menu: [
    { id: "show", label: "Show" },
    { id: "quit", label: "Quit" },
  ],
});

Desktop.addListener("trayMenuClick", ({ itemId }) => {
  if (itemId === "quit") Desktop.quit();
});

// Global shortcut
await Desktop.registerShortcut({ id: "toggle", accelerator: "CmdOrCtrl+Shift+Space" });
Desktop.addListener("shortcutPressed", ({ id }) => {
  if (id === "toggle") Desktop.showWindow();
});

// Clipboard
await Desktop.writeToClipboard({ text: "hello" });
const { text } = await Desktop.readFromClipboard();

// System permission check
const state = await Desktop.checkPermission({ id: "microphone" });
if (state.status !== "granted") {
  await Desktop.requestPermission({ id: "microphone", reason: "Voice input" });
}
```

## Platform availability

- **Node + Electrobun:** Full support for all capabilities.
- **Browser:** Notifications, clipboard, window focus/close/fullscreen, and permissions for `camera`, `microphone`, `location`, `notifications` work via Web APIs. System tray, global shortcuts, auto-launch, `getPath`, and `showItemInFolder` are unavailable.
- **iOS / Android:** Not supported.

## Building

```bash
bun run --cwd plugins/plugin-native-desktop build
```

This runs `tsc` then rollup to produce `dist/esm/` (ESM), `dist/plugin.js` (IIFE), and `dist/plugin.cjs.js` (CJS).

## Package name

The npm package name is `@elizaos/capacitor-desktop`. The directory is `plugins/plugin-native-desktop`.
