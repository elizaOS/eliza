---
title: "Native Modules"
sidebarTitle: "Native Modules"
description: "Electrobun RPC-based native module system that gives the Eliza desktop app access to platform capabilities."
---

The Eliza desktop app exposes platform capabilities to the web renderer through a set of **native modules** running in the Electrobun Bun host. Each module is initialized in `initializeNativeModules()`, and Bun-side request handlers are wired through `registerRpcHandlers()`.

Renderer code talks to the host through `window.__ELIZA_ELECTROBUN_RPC__`:

- `request.<method>(params)` for request/response calls into Bun
- `onMessage(name, listener)` / `offMessage(name, listener)` for Bun push events

There are **10 native modules** with **140+ request aliases and push messages** in total, covering agent lifecycle, desktop integration, network discovery, voice I/O, wake-word detection, screen capture, camera, canvas windows, geolocation, and system permissions.

## RPC Alias Conventions

The source of truth still keeps legacy channel-style aliases in `rpc-schema.ts` using the pattern `<module>:<action>` (for example `agent:start`, `desktop:registerShortcut`, `gateway:startDiscovery`). The public renderer API maps those aliases onto camelCase request methods and message names.

Examples:

- `agent:start` → `window.__ELIZA_ELECTROBUN_RPC__.request.agentStart()`
- `desktop:registerShortcut` → `window.__ELIZA_ELECTROBUN_RPC__.request.desktopRegisterShortcut(...)`
- `agent:status` push event → `window.__ELIZA_ELECTROBUN_RPC__.onMessage("agentStatusUpdate", ...)`

**Direction** describes the communication model:

- **request** — renderer calls Bun and awaits a response
- **message** — Bun pushes an event to the renderer

```typescript
const rpc = window.__ELIZA_ELECTROBUN_RPC__;

// Request: call a native module and await its response
const status = await rpc.request.agentStart();

// Message: listen for push notifications from the Bun host
rpc.onMessage("agentStatusUpdate", (status) => {
  console.log(status.state);
});
```

## Modules

- [Agent](#agent) — embedded Eliza runtime lifecycle
- [Desktop Manager](#desktop-manager) — tray, shortcuts, windows, notifications, clipboard, shell
- [Gateway Discovery](#gateway-discovery) — mDNS/Bonjour local network scanning
- [Talk Mode](#talk-mode) — speech-to-text and text-to-speech pipeline
- [Swabble](#swabble) — wake-word detection
- [Screen Capture](#screen-capture) — screenshots and screen recording
- [Camera](#camera) — camera enumeration, preview, and recording
- [Canvas](#canvas) — auxiliary BrowserWindow management and A2UI injection
- [Location](#location) — IP-based geolocation
- [Permissions](#permissions) — system permission checking and requesting

---

## Agent

**Class**: `AgentManager` | **Channels**: 4 invoke, 1 event

Manages the embedded elizaOS agent runtime lifecycle — starting, stopping, restarting, and monitoring the local agent process.

**Return type** — `AgentStatus`:
```typescript
interface AgentStatus {
  state: "not_started" | "starting" | "running" | "stopped" | "error";
  agentName?: string;
  port?: number;
  startedAt?: string;
  error?: string;
}
```

| Channel | Direction | Description |
|---|---|---|
| `agent:start` | invoke | Starts the embedded agent. Returns `AgentStatus`. |
| `agent:stop` | invoke | Stops the running agent. Returns `{ ok: true }`. |
| `agent:restart` | invoke | Stops and restarts the agent. Returns `AgentStatus`. |
| `agent:status` | invoke | Reads the current agent state. Returns `AgentStatus`. |
| `agent:status` | event | Pushed to the renderer whenever agent state changes. Payload: `AgentStatus`. |

---

## Desktop Manager

**Class**: `DesktopManager` | **Channels**: 32 invoke, 20 events

The largest native module. Wraps desktop system APIs for the tray, global shortcuts, auto-launch, window management, native notifications, power monitoring, clipboard, and shell operations.

### Tray

| Channel | Direction | Description |
|---|---|---|
| `desktop:createTray` | invoke | Creates the system tray icon. |
| `desktop:updateTray` | invoke | Updates the tray icon or tooltip. |
| `desktop:destroyTray` | invoke | Removes the tray icon. |
| `desktop:setTrayMenu` | invoke | Sets the context menu items for the tray. |
| `desktop:trayClick` | event | Fired when the tray icon is left-clicked. |
| `desktop:trayDoubleClick` | event | Fired on a double-click of the tray icon. |
| `desktop:trayRightClick` | event | Fired on a right-click of the tray icon. |
| `desktop:trayMenuClick` | event | Fired when a tray menu item is selected. Payload includes the menu item id. |

### Global Shortcuts

| Channel | Direction | Description |
|---|---|---|
| `desktop:registerShortcut` | invoke | Registers a global keyboard shortcut. |
| `desktop:unregisterShortcut` | invoke | Unregisters a specific shortcut by id. |
| `desktop:unregisterAllShortcuts` | invoke | Unregisters all previously registered shortcuts. |
| `desktop:isShortcutRegistered` | invoke | Returns `true` if a shortcut id is currently registered. |
| `desktop:shortcutPressed` | event | Fired when a registered shortcut is triggered. Payload: `{ id: string }`. |

### Auto Launch

| Channel | Direction | Description |
|---|---|---|
| `desktop:setAutoLaunch` | invoke | Enables or disables launch at system startup. |
| `desktop:getAutoLaunchStatus` | invoke | Returns whether auto-launch is currently enabled. |

### Window Management

| Channel | Direction | Description |
|---|---|---|
| `desktop:setWindowOptions` | invoke | Applies `BrowserWindowConstructorOptions` to the main window. |
| `desktop:getWindowBounds` | invoke | Returns `{ x, y, width, height }` for the main window. |
| `desktop:setWindowBounds` | invoke | Moves and resizes the main window. |
| `desktop:minimizeWindow` | invoke | Minimizes the main window. |
| `desktop:maximizeWindow` | invoke | Maximizes the main window. |
| `desktop:unmaximizeWindow` | invoke | Restores the main window from maximized state. |
| `desktop:closeWindow` | invoke | Closes the main window. |
| `desktop:showWindow` | invoke | Shows a hidden main window. |
| `desktop:hideWindow` | invoke | Hides the main window without closing it. |
| `desktop:focusWindow` | invoke | Brings the main window to the foreground. |
| `desktop:isWindowMaximized` | invoke | Returns `true` if the window is maximized. |
| `desktop:isWindowMinimized` | invoke | Returns `true` if the window is minimized. |
| `desktop:isWindowVisible` | invoke | Returns `true` if the window is visible. |
| `desktop:isWindowFocused` | invoke | Returns `true` if the window has focus. |
| `desktop:setAlwaysOnTop` | invoke | Pins or unpins the window above all other windows. |
| `desktop:setFullscreen` | invoke | Enters or exits fullscreen mode. |
| `desktop:setOpacity` | invoke | Sets the window opacity (0.0–1.0). |
| `desktop:windowFocus` | event | Fired when the main window gains focus. |
| `desktop:windowBlur` | event | Fired when the main window loses focus. |
| `desktop:windowMaximize` | event | Fired when the window is maximized. |
| `desktop:windowUnmaximize` | event | Fired when the window is unmaximized. |
| `desktop:windowMinimize` | event | Fired when the window is minimized. |
| `desktop:windowRestore` | event | Fired when the window is restored from minimized state. |
| `desktop:windowClose` | event | Fired when the window is closed. |

### Notifications

| Channel | Direction | Description |
|---|---|---|
| `desktop:showNotification` | invoke | Displays a native OS notification. |
| `desktop:closeNotification` | invoke | Dismisses a notification by id. |
| `desktop:notificationClick` | event | Fired when the user clicks a notification. |
| `desktop:notificationAction` | event | Fired when the user clicks an action button on a notification. |
| `desktop:notificationReply` | event | Fired when the user submits a reply from a notification (macOS). |

### Power Monitoring

| Channel | Direction | Description |
|---|---|---|
| `desktop:getPowerState` | invoke | Returns AC vs battery **plus** live HID idle time and session lock state for LifeOps circadian inference: **macOS** (`pmset -g batt` + `ioreg -c IOHIDSystem` HID idle-time + `CGSessionCopyCurrentDictionary` lock state), **Linux** (`/sys/class/power_supply` Battery `status`), **Windows** (`PowerStatus.PowerLineStatus`). The `idleTime` (seconds) and `idleState` fields on `DesktopPowerState` are live on macOS; Linux/Windows still return them best-effort. |
| `desktop:powerSuspend` | event | Fired when the system is about to sleep. |
| `desktop:powerResume` | event | Fired when the system wakes from sleep. |
| `desktop:powerOnAC` | event | Fired when the system is plugged in. |
| `desktop:powerOnBattery` | event | Fired when the system switches to battery. |

### App

| Channel | Direction | Description |
|---|---|---|
| `desktop:quit` | invoke | Quits the desktop app. |
| `desktop:relaunch` | invoke | Relaunches the app. |
| `desktop:getVersion` | invoke | Returns the current app version string. |
| `desktop:isPackaged` | invoke | Returns `true` if running a production build. |
| `desktop:getPath` | invoke | Returns a desktop app path (for example `userData` or `downloads`). |

### Clipboard

| Channel | Direction | Description |
|---|---|---|
| `desktop:writeToClipboard` | invoke | Writes text to the system clipboard. |
| `desktop:readFromClipboard` | invoke | Returns the current clipboard text. |
| `desktop:clearClipboard` | invoke | Clears the clipboard. |

### Shell

| Channel | Direction | Description |
|---|---|---|
| `desktop:openExternal` | invoke | Opens a URL in the default browser. |
| `desktop:showItemInFolder` | invoke | Reveals a file in Finder / Explorer. |
| `desktop:beep` | invoke | Plays the system beep sound. |

---

## Gateway Discovery

**Class**: `GatewayDiscovery` | **Channels**: 4 invoke, 1 event

Scans the local network for `_eliza._tcp` services using mDNS/Bonjour and surfaces discovered gateway instances to the renderer.

| Channel | Direction | Description |
|---|---|---|
| `gateway:startDiscovery` | invoke | Starts mDNS scanning on the local network. |
| `gateway:stopDiscovery` | invoke | Stops the active scan. |
| `gateway:getDiscoveredGateways` | invoke | Returns an array of currently known gateways. |
| `gateway:isDiscovering` | invoke | Returns `true` if a scan is in progress. |
| `gateway:discovery` | event | Pushed when a gateway is found, updated, or lost. Payload: `{ type: "found" \| "updated" \| "lost", gateway }`. |

---

## Talk Mode

**Class**: `TalkModeManager` | **Channels**: 10 invoke, 7 events

Manages the full speech pipeline: speech-to-text via Whisper or the Web Speech API, and text-to-speech via ElevenLabs or the system TTS engine.

| Channel | Direction | Description |
|---|---|---|
| `talkmode:start` | invoke | Starts the Talk Mode session (begins listening). |
| `talkmode:stop` | invoke | Stops the active session. |
| `talkmode:speak` | invoke | Sends text to the TTS engine for playback. |
| `talkmode:stopSpeaking` | invoke | Cancels the current TTS playback. |
| `talkmode:isSpeaking` | invoke | Returns `true` if TTS is actively playing. |
| `talkmode:getState` | invoke | Returns the current Talk Mode state object. |
| `talkmode:isEnabled` | invoke | Returns `true` if Talk Mode is enabled in settings. |
| `talkmode:updateConfig` | invoke | Updates Talk Mode configuration at runtime. |
| `talkmode:isWhisperAvailable` | invoke | Returns `true` if the local Whisper model is available. |
| `talkmode:getWhisperInfo` | invoke | Returns metadata about the loaded Whisper model. |
| `talkmode:transcript` | event | Pushed when a speech-to-text transcript is ready. |
| `talkmode:speaking` | event | Pushed when TTS playback starts. |
| `talkmode:speakComplete` | event | Pushed when TTS playback finishes. |
| `talkmode:audioChunk` | event | Pushed with raw PCM audio chunks during recording. |
| `talkmode:audioComplete` | event | Pushed when audio recording ends. |
| `talkmode:stateChange` | event | Pushed whenever the Talk Mode state changes. |
| `talkmode:error` | event | Pushed when a speech pipeline error occurs. |

---

## Swabble

**Class**: `SwabbleManager` | **Channels**: 6 invoke, 3 events

Runs continuous wake-word detection in the background using fuzzy phrase matching. Whisper is used for transcription when available.

| Channel | Direction | Description |
|---|---|---|
| `swabble:start` | invoke | Starts the wake-word listener. |
| `swabble:stop` | invoke | Stops the wake-word listener. |
| `swabble:isListening` | invoke | Returns `true` if the listener is active. |
| `swabble:getConfig` | invoke | Returns the current wake-word configuration. |
| `swabble:updateConfig` | invoke | Updates the wake-word phrases and sensitivity at runtime. |
| `swabble:isWhisperAvailable` | invoke | Returns `true` if Whisper is available for transcription. |
| `swabble:stateChange` | event | Pushed when the listener starts or stops. |
| `swabble:transcript` | event | Pushed with the transcribed phrase that was detected. |
| `swabble:wakeWord` | event | Pushed when a configured wake-word is matched. |

---

## Screen Capture

**Class**: `ScreenCaptureManager` | **Channels**: 9 invoke, 1 event

Provides access to screen sources, screenshots, and screen recording.

- App-window capture uses native OS tooling by default:
  - macOS: `screencapture`
  - Windows: PowerShell `System.Drawing.CopyFromScreen`
  - Linux: `scrot`, falling back to ImageMagick `import`
- Game URL capture uses a dedicated `BrowserWindow` path when a game URL is provided.

| Channel | Direction | Description |
|---|---|---|
| `screencapture:getSources` | invoke | Returns an array of available screen and window sources. |
| `screencapture:takeScreenshot` | invoke | Captures a full screenshot of the specified source. |
| `screencapture:captureWindow` | invoke | Captures a screenshot of a specific window by id. |
| `screencapture:saveScreenshot` | invoke | Saves a screenshot buffer to disk and returns the file path. |
| `screencapture:startRecording` | invoke | Starts a screen recording session. |
| `screencapture:stopRecording` | invoke | Stops the recording and returns the recorded file path. |
| `screencapture:pauseRecording` | invoke | Pauses an active recording session. |
| `screencapture:resumeRecording` | invoke | Resumes a paused recording session. |
| `screencapture:getRecordingState` | invoke | Returns the current recording state (`idle`, `recording`, `paused`). |
| `screencapture:recordingState` | event | Pushed whenever the recording state changes. |

---

## Camera

**Class**: `CameraManager` | **Channels**: 10 invoke, 0 events

Manages camera enumeration, live preview, photo capture, and video recording via a hidden renderer window. Permission checks are integrated directly into the module.

| Channel | Direction | Description |
|---|---|---|
| `camera:getDevices` | invoke | Returns a list of available camera devices. |
| `camera:startPreview` | invoke | Starts a live preview stream from the specified device. |
| `camera:stopPreview` | invoke | Stops the active preview stream. |
| `camera:switchCamera` | invoke | Switches the active preview to a different camera device. |
| `camera:capturePhoto` | invoke | Captures a still photo from the current preview. Returns image data. |
| `camera:startRecording` | invoke | Starts video recording from the active camera. |
| `camera:stopRecording` | invoke | Stops video recording and returns the file path. |
| `camera:getRecordingState` | invoke | Returns the current recording state. |
| `camera:checkPermissions` | invoke | Returns whether camera permission has been granted. |
| `camera:requestPermissions` | invoke | Prompts the user for camera access permission. |

---

## Canvas

**Class**: `CanvasManager` | **Channels**: 16 invoke, 3 events

Creates and manages auxiliary `BrowserWindow` instances ("canvas windows") for headless or visible web navigation, JavaScript evaluation, snapshot capture, and A2UI message injection.

### Window Lifecycle

| Channel | Direction | Description |
|---|---|---|
| `canvas:createWindow` | invoke | Creates a new canvas window. Returns a window id. |
| `canvas:destroyWindow` | invoke | Destroys a canvas window by id. |
| `canvas:listWindows` | invoke | Returns an array of all active canvas window ids and their current URLs. |

### Navigation

| Channel | Direction | Description |
|---|---|---|
| `canvas:navigate` | invoke | Navigates a canvas window to a URL. |
| `canvas:eval` | invoke | Evaluates a JavaScript expression in a canvas window and returns the result. |

### Snapshots

| Channel | Direction | Description |
|---|---|---|
| `canvas:snapshot` | invoke | Captures a screenshot of a canvas window. Returns image data. |

### A2UI Messaging

| Channel | Direction | Description |
|---|---|---|
| `canvas:a2uiPush` | invoke | Injects an A2UI message into the canvas window's renderer. |
| `canvas:a2uiReset` | invoke | Resets the A2UI state in a canvas window. |

### Visibility and Bounds

| Channel | Direction | Description |
|---|---|---|
| `canvas:show` | invoke | Makes a canvas window visible. |
| `canvas:hide` | invoke | Hides a canvas window without destroying it. |
| `canvas:resize` | invoke | Resizes a canvas window. |
| `canvas:focus` | invoke | Brings a canvas window to the foreground. |
| `canvas:getBounds` | invoke | Returns `{ x, y, width, height }` for a canvas window. |
| `canvas:setBounds` | invoke | Moves and resizes a canvas window. |

### Events

| Channel | Direction | Description |
|---|---|---|
| `canvas:didFinishLoad` | event | Pushed when a canvas window finishes loading a page. |
| `canvas:didFailLoad` | event | Pushed when a canvas window navigation fails. Payload includes the error code and description. |
| `canvas:windowClosed` | event | Pushed when a canvas window is closed (e.g., by a page calling `window.close()`). |

---

## Location

**Class**: `LocationManager` | **Channels**: 4 invoke, 2 events

Provides IP-based geolocation with position watching and local caching. Results are pushed as events for watched positions.

| Channel | Direction | Description |
|---|---|---|
| `location:getCurrentPosition` | invoke | Fetches the current geographic position. Returns a position object. |
| `location:watchPosition` | invoke | Starts watching for position changes. Returns a watch id. |
| `location:clearWatch` | invoke | Stops watching a position by watch id. |
| `location:getLastKnownLocation` | invoke | Returns the most recently cached location without a network call. |
| `location:update` | event | Pushed when a watched position is updated. Payload: position object. |
| `location:error` | event | Pushed when a geolocation error occurs. Payload: error details. |

---

## Permissions

**Class**: `PermissionManager` | **Channels**: 9 invoke, 1 event

Checks and requests OS-level permissions for accessibility, screen recording, microphone, camera, and shell access. Behavior varies by platform (macOS, Windows, Linux).

| Channel | Direction | Description |
|---|---|---|
| `permissions:getAll` | invoke | Returns the current state of all tracked permissions. |
| `permissions:check` | invoke | Checks whether a specific permission is granted. |
| `permissions:request` | invoke | Prompts the user to grant a specific permission. |
| `permissions:openSettings` | invoke | Opens the OS settings panel relevant to a permission. |
| `permissions:checkFeature` | invoke | Returns whether a named app feature is available given current permissions. |
| `permissions:setShellEnabled` | invoke | Enables or disables shell access permission for the app. |
| `permissions:isShellEnabled` | invoke | Returns whether shell access is currently enabled. |
| `permissions:clearCache` | invoke | Clears the cached permission states, forcing a fresh check on next query. |
| `permissions:getPlatform` | invoke | Returns the current platform identifier (`darwin`, `win32`, `linux`). |
| `permissions:changed` | event | Pushed when any permission state changes. Payload: updated permission map. |

---

## Usage Example

```typescript
const rpc = window.__ELIZA_ELECTROBUN_RPC__;

// Register a global shortcut from the renderer
await rpc.request.desktopRegisterShortcut({
  id: "open-chat",
  accelerator: "CmdOrCtrl+Shift+M",
});

// Listen for the shortcut being pressed
rpc.onMessage("desktopShortcutPressed", ({ id }) => {
  if (id === "open-chat") openChatWindow();
});

// Start the embedded agent
const status = await rpc.request.agentStart();
console.log(status.state); // "starting" | "running" | "error"

// React to live agent state changes
rpc.onMessage("agentStatusUpdate", (nextStatus) => {
  updateAgentIndicator(nextStatus);
});

// Check a permission before using a feature
const cameraPermission = await rpc.request.permissionsCheck({ id: "camera" });
if (cameraPermission.status !== "granted") {
  await rpc.request.permissionsRequest({ id: "camera" });
}
```

The renderer usually should not call this global directly. Prefer the shared app helpers in `eliza/packages/app-core/src/bridge/electrobun-rpc.ts`, which wrap the same preload bridge behind request/message helpers used by the app and plugins.

---

## Related

- [Desktop App](/apps/desktop) — overview of the desktop application architecture
- [Deep Linking](/apps/desktop/deep-linking) — `eliza://` URL protocol handled via the Canvas module
- [Capacitor Plugins](/apps/mobile/capacitor-plugins) — equivalent native plugin system for iOS and Android
