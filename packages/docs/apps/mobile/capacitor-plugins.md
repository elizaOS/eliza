---
title: "Capacitor Plugins"
sidebarTitle: "Capacitor Plugins"
description: "Nine custom Capacitor plugins that give the Eliza mobile app access to native iOS and Android capabilities."
---

The Eliza mobile app ships nine custom Capacitor plugins plus the core `@capacitor/haptics` plugin. Each plugin is an independent package under `eliza/packages/native-plugins/<name>/` and must be compiled before the web app can bundle it (`bun run plugin:build` from `apps/app`). Plugins are wrapped by the plugin bridge (`src/bridge/plugin-bridge.ts`), which performs capability detection per platform and provides graceful degradation to web API fallbacks where possible.

All plugins follow the same structure: a TypeScript interface describing the web-facing API, a web implementation used in browser environments, and native implementations for iOS (Swift) and Android (Kotlin). On platforms where a feature is unavailable, plugin calls are silently caught and logged by the bridge's `Proxy` wrapper.

## Plugin Bridge

The bridge is the single entry point for all plugin access. It initializes at app startup, probes each plugin for availability, and exposes the results at `window.Eliza.plugins` and `window.Eliza.pluginCapabilities`.

Use `waitForBridge()` before accessing any plugin, then check `isFeatureAvailable()` for platform-specific features before calling them:

```typescript
import { waitForBridge, isFeatureAvailable } from "./bridge/plugin-bridge";

await waitForBridge();

if (isFeatureAvailable("gateway")) {
  await window.Eliza.plugins.gateway.startDiscovery();
}
```

**Capability map** — keys accepted by `isFeatureAvailable()`:

| Key | Plugin |
|-----|--------|
| `gateway` | `@elizaos/capacitor-gateway` |
| `voiceWake` | `@elizaos/capacitor-swabble` |
| `talkMode` | `@elizaos/capacitor-talkmode` |
| `camera` | `@elizaos/capacitor-camera` |
| `location` | `@elizaos/capacitor-location` |
| `screenCapture` | `@elizaos/capacitor-screencapture` |
| `canvas` | `@elizaos/capacitor-canvas` |
| `desktop` | `@elizaos/capacitor-desktop` |

---

## @elizaos/capacitor-gateway

WebSocket RPC connection to a Eliza gateway with mDNS/Bonjour discovery of local gateways on the same network. Handles token or password authentication, automatic reconnection, and session continuity via session keys.

### Methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `startDiscovery` | — | `Promise<void>` | Begin mDNS scanning for gateways on the local network |
| `stopDiscovery` | — | `Promise<void>` | Stop mDNS scanning |
| `getDiscoveredGateways` | — | `Promise<Gateway[]>` | Return the current list of discovered gateways |
| `connect` | `url: string, token?: string, password?: string, clientName?: string, sessionKey?: string, role?: string, scopes?: string[]` | `Promise<void>` | Open a WebSocket RPC connection to the given gateway URL |
| `disconnect` | — | `Promise<void>` | Close the active connection |
| `isConnected` | — | `Promise<{ connected: boolean }>` | Return the current connection status |
| `send` | `method: string, params?: Record<string, unknown>` | `Promise<unknown>` | Send an RPC message over the active connection |
| `getConnectionInfo` | — | `Promise<ConnectionInfo>` | Return metadata for the current connection (URL, role, scopes, session key) |

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `gatewayEvent` | `{ type: string, data: unknown }` | Arbitrary RPC event pushed from the gateway |
| `stateChange` | `{ state: "connecting" \| "connected" \| "disconnected" \| "reconnecting" }` | Connection state transitions |
| `error` | `{ message: string, code?: string }` | Connection or protocol error |
| `discovery` | `{ action: "found" \| "lost" \| "updated", gateway: Gateway }` | A gateway was discovered, lost, or its metadata changed |

---

## @elizaos/capacitor-swabble

Continuous background wake-word detection. Uses the native Speech framework on iOS, `SpeechRecognizer` on Android, or Whisper.cpp on desktop. Falls back to the Web Speech API in browser environments.

### Methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `start` | `config: { triggers: string[], locale?: string, sampleRate?: number, modelSize?: string }` | `Promise<void>` | Start listening for wake words |
| `stop` | — | `Promise<void>` | Stop listening |
| `isListening` | — | `Promise<{ listening: boolean }>` | Return whether the detector is currently active |
| `getConfig` | — | `Promise<SwabbleConfig>` | Return the active configuration |
| `updateConfig` | `config: Partial<SwabbleConfig>` | `Promise<void>` | Update configuration without stopping the detector |
| `checkPermissions` | — | `Promise<PermissionStatus>` | Check microphone and speech recognition permissions |
| `requestPermissions` | — | `Promise<PermissionStatus>` | Request required permissions from the user |
| `getAudioDevices` | — | `Promise<AudioDevice[]>` | List available audio input devices |
| `setAudioDevice` | `deviceId: string` | `Promise<void>` | Set the active audio input device |

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `wakeWord` | `{ trigger: string, confidence: number }` | A wake word from the `triggers` list was detected |
| `transcript` | `{ text: string, isFinal: boolean }` | Interim or final speech transcription following a wake word |
| `stateChange` | `{ state: "idle" \| "listening" \| "processing" \| "error" }` | Detector state transitions |
| `audioLevel` | `{ level: number }` | Real-time microphone amplitude (0–1) for UI indicators |
| `error` | `{ message: string, code?: string }` | Detection or permission error |

---

## @elizaos/capacitor-talkmode

Full speech pipeline integrating STT, chat relay to the agent, and TTS output. STT uses native recognition or Whisper; TTS uses ElevenLabs streaming or native speech synthesis. The pipeline is stateful — only one phase is active at a time.

### Methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `start` | `config?: TalkModeConfig` | `Promise<void>` | Activate the talk mode pipeline |
| `stop` | — | `Promise<void>` | Deactivate and release audio resources |
| `isEnabled` | — | `Promise<{ enabled: boolean }>` | Return whether talk mode is currently active |
| `getState` | — | `Promise<{ state: "idle" \| "listening" \| "processing" \| "speaking" \| "error" }>` | Return the current pipeline state |
| `updateConfig` | `config: Partial<TalkModeConfig>` | `Promise<void>` | Update pipeline settings at runtime |
| `speak` | `text: string, directive?: string, useSystemTts?: boolean` | `Promise<void>` | Speak text directly, bypassing STT/chat phases |
| `stopSpeaking` | — | `Promise<void>` | Interrupt current TTS playback |
| `isSpeaking` | — | `Promise<{ speaking: boolean }>` | Return whether TTS is currently active |
| `checkPermissions` | — | `Promise<PermissionStatus>` | Check microphone permissions |
| `requestPermissions` | — | `Promise<PermissionStatus>` | Request microphone permissions |

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `stateChange` | `{ state: "idle" \| "listening" \| "processing" \| "speaking" \| "error" }` | Pipeline state transitions |
| `transcript` | `{ text: string, isFinal: boolean }` | STT output (interim and final) |
| `speaking` | `{ text: string }` | TTS has begun speaking this text |
| `speakComplete` | `{ text: string }` | TTS finished speaking |
| `error` | `{ message: string, code?: string, phase?: string }` | Error in any pipeline phase |

---

## @elizaos/capacitor-camera

Camera enumeration, live preview rendering into an HTML element, photo capture, video recording, and manual controls. On web, falls back to `getUserMedia`.

### Methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `getDevices` | — | `Promise<CameraDevice[]>` | List all available camera devices |
| `startPreview` | `element: HTMLElement, deviceId?: string, direction?: "front" \| "back", resolution?: string, frameRate?: number, mirror?: boolean` | `Promise<void>` | Begin a live camera preview rendered into the given element |
| `stopPreview` | — | `Promise<void>` | Stop the live preview |
| `switchCamera` | — | `Promise<void>` | Toggle between front and back cameras |
| `capturePhoto` | `quality?: number, format?: "jpeg" \| "png" \| "webp", width?: number, height?: number` | `Promise<{ dataUrl: string }>` | Capture a still photo from the active preview |
| `startRecording` | `quality?: string, maxDuration?: number, audio?: boolean, bitrate?: number` | `Promise<void>` | Begin video recording |
| `stopRecording` | — | `Promise<{ uri: string }>` | Stop recording and return the file URI |
| `getRecordingState` | — | `Promise<{ state: string, duration: number }>` | Return current recording state and elapsed duration |
| `getSettings` | — | `Promise<CameraSettings>` | Return current camera settings |
| `setSettings` | `settings: Partial<CameraSettings>` | `Promise<void>` | Update camera settings |
| `setZoom` | `factor: number` | `Promise<void>` | Set the zoom level (1.0 = no zoom) |
| `setFocusPoint` | `x: number, y: number` | `Promise<void>` | Set manual focus point (normalized 0–1 coordinates) |
| `setExposurePoint` | `x: number, y: number` | `Promise<void>` | Set manual exposure point (normalized 0–1 coordinates) |
| `checkPermissions` | — | `Promise<PermissionStatus>` | Check camera and microphone permissions |
| `requestPermissions` | — | `Promise<PermissionStatus>` | Request camera and microphone permissions |

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `frame` | `{ timestamp: number }` | Fired for each rendered preview frame |
| `error` | `{ message: string, code?: string }` | Camera or recording error |
| `recordingState` | `{ state: string, duration: number }` | Recording state change |

---

## @elizaos/capacitor-location

GPS and network-based geolocation with configurable accuracy, position watching, and background location support on iOS and Android.

### Methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `getCurrentPosition` | `accuracy?: "high" \| "balanced" \| "low", maxAge?: number, timeout?: number` | `Promise<Position>` | Fetch the current device position |
| `watchPosition` | `minDistance?: number, minInterval?: number` | `Promise<{ watchId: string }>` | Begin continuous position updates |
| `clearWatch` | `watchId: string` | `Promise<void>` | Stop a position watch |
| `checkPermissions` | — | `Promise<PermissionStatus>` | Check location permissions |
| `requestPermissions` | — | `Promise<PermissionStatus>` | Request location permissions |

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `locationChange` | `{ position: Position }` | A new position is available from an active watch |
| `error` | `{ code: "PERMISSION_DENIED" \| "POSITION_UNAVAILABLE" \| "TIMEOUT", message: string }` | Position acquisition failed |

---

## @elizaos/capacitor-screencapture

Screenshots and screen recording with pause/resume support. On web, falls back to `getDisplayMedia` for screen recording.

### Methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `isSupported` | — | `Promise<{ supported: boolean }>` | Check whether screen capture is available on the current platform |
| `captureScreenshot` | `format?: "png" \| "jpeg" \| "webp", quality?: number, scale?: number` | `Promise<{ dataUrl: string }>` | Capture a still screenshot |
| `startRecording` | `quality?: string, maxDuration?: number, fps?: number, captureAudio?: boolean` | `Promise<void>` | Begin screen recording |
| `stopRecording` | — | `Promise<{ uri: string }>` | Stop recording and return the file URI |
| `pauseRecording` | — | `Promise<void>` | Pause an active recording |
| `resumeRecording` | — | `Promise<void>` | Resume a paused recording |
| `getRecordingState` | — | `Promise<{ state: string, duration: number }>` | Return recording state and elapsed duration |
| `checkPermissions` | — | `Promise<PermissionStatus>` | Check screen capture permissions |
| `requestPermissions` | — | `Promise<PermissionStatus>` | Request screen capture permissions |

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `recordingState` | `{ state: string, duration: number }` | Recording state change (started, paused, stopped) |
| `error` | `{ message: string, code?: string }` | Capture or recording error |

---

## @elizaos/capacitor-canvas

Drawing primitives, layer management, embedded web view control, JavaScript evaluation, A2UI directive injection, and `eliza://` deep link interception. The canvas layer renders natively on iOS and Android and sits above the Capacitor web view.

### Drawing Methods

| Method | Parameters | Description |
|--------|-----------|-------------|
| `create` | `id: string, config?: CanvasConfig` | Create a new canvas surface |
| `destroy` | `id: string` | Destroy a canvas surface and release resources |
| `attach` | `id: string, element: HTMLElement` | Attach a canvas to a DOM element |
| `detach` | `id: string` | Detach a canvas from its DOM element |
| `resize` | `id: string, width: number, height: number` | Resize the canvas surface |
| `clear` | `id: string` | Clear all content from the canvas |
| `drawRect` | `id: string, x: number, y: number, width: number, height: number, style?: DrawStyle` | Draw a rectangle |
| `drawEllipse` | `id: string, cx: number, cy: number, rx: number, ry: number, style?: DrawStyle` | Draw an ellipse |
| `drawLine` | `id: string, x1: number, y1: number, x2: number, y2: number, style?: DrawStyle` | Draw a line segment |
| `drawPath` | `id: string, path: PathCommand[], style?: DrawStyle` | Draw an arbitrary path |
| `drawText` | `id: string, text: string, x: number, y: number, style?: TextStyle` | Draw text |
| `drawImage` | `id: string, src: string, x: number, y: number, width?: number, height?: number` | Draw an image from a URI or data URL |
| `drawBatch` | `id: string, commands: DrawCommand[]` | Execute multiple draw commands in a single call |
| `getPixelData` | `id: string, x: number, y: number, width: number, height: number` | Return raw pixel data for a region |
| `toImage` | `id: string, format?: string, quality?: number` | Export the canvas as a data URL |
| `setTransform` | `id: string, matrix: number[]` | Apply a transformation matrix |
| `resetTransform` | `id: string` | Reset to the identity transform |

### Layer Methods

| Method | Parameters | Description |
|--------|-----------|-------------|
| `createLayer` | `canvasId: string, layerId: string, config?: LayerConfig` | Add a new layer to a canvas |
| `updateLayer` | `canvasId: string, layerId: string, config: Partial<LayerConfig>` | Update layer properties (opacity, visibility, order) |
| `deleteLayer` | `canvasId: string, layerId: string` | Remove a layer |
| `getLayers` | `canvasId: string` | Return all layers for a canvas |

### Web View Methods

| Method | Parameters | Description |
|--------|-----------|-------------|
| `navigate` | `canvasId: string, url: string` | Navigate the embedded web view to a URL |
| `eval` | `canvasId: string, script: string` | Evaluate JavaScript in the embedded web view |
| `snapshot` | `canvasId: string` | Capture a screenshot of the embedded web view |
| `a2uiPush` | `canvasId: string, directive: object` | Inject an A2UI directive into the web view |
| `a2uiReset` | `canvasId: string` | Reset the A2UI state in the web view |

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `touch` | `{ canvasId: string, x: number, y: number, type: string }` | Touch or pointer event on the canvas |
| `render` | `{ canvasId: string, timestamp: number }` | Canvas render frame tick |
| `webViewReady` | `{ canvasId: string }` | Embedded web view has finished loading |
| `navigationError` | `{ canvasId: string, url: string, error: string }` | Web view navigation failed |
| `deepLink` | `{ canvasId: string, url: string }` | A `eliza://` deep link was intercepted in the web view |
| `a2uiAction` | `{ canvasId: string, action: string, payload: unknown }` | An A2UI action was triggered from within the web view |

---

## @elizaos/capacitor-agent

Agent lifecycle management. Communicates with the Eliza agent process via IPC on Electrobun and via HTTP on iOS, Android, and web.

### Methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `start` | — | `Promise<void>` | Start the agent process |
| `stop` | — | `Promise<void>` | Stop the agent process |
| `getStatus` | — | `Promise<{ state: AgentState }>` | Return the current agent state |
| `chat` | `text: string` | `Promise<void>` | Send a text message to the running agent |

### Agent States

| State | Description |
|-------|-------------|
| `not_started` | Agent has never been started in this session |
| `starting` | Agent process is initializing |
| `running` | Agent is active and accepting messages |
| `stopped` | Agent was stopped cleanly |
| `error` | Agent encountered a fatal error |

---

## @elizaos/capacitor-desktop

Electrobun-only plugin for desktop integration. All methods are no-ops on iOS and Android. Check `isFeatureAvailable("desktop")` before calling any method.

### Tray Methods

| Method | Parameters | Description |
|--------|-----------|-------------|
| `createTray` | `config: TrayConfig` | Create the system tray icon |
| `updateTray` | `config: Partial<TrayConfig>` | Update the tray icon or tooltip |
| `destroyTray` | — | Remove the system tray icon |
| `setTrayMenu` | `items: MenuItem[]` | Set the tray context menu items |

### Global Shortcut Methods

| Method | Parameters | Description |
|--------|-----------|-------------|
| `registerShortcut` | `accelerator: string, id: string` | Register a global keyboard shortcut |
| `unregisterShortcut` | `accelerator: string` | Unregister a specific shortcut |
| `unregisterAllShortcuts` | — | Unregister all shortcuts registered by this app |
| `isShortcutRegistered` | `accelerator: string` | Check whether a shortcut is currently registered |

### Auto Launch Methods

| Method | Parameters | Description |
|--------|-----------|-------------|
| `setAutoLaunch` | `enabled: boolean` | Enable or disable launch at login |
| `getAutoLaunchStatus` | — | Return whether auto launch is currently enabled |

### Window Methods

| Method | Parameters | Description |
|--------|-----------|-------------|
| `minimize` | — | Minimize the window |
| `maximize` | — | Maximize the window |
| `unmaximize` | — | Restore the window from maximized state |
| `isMaximized` | — | Check whether the window is maximized |
| `hide` | — | Hide the window |
| `show` | — | Show the window |
| `focus` | — | Bring the window to focus |
| `close` | — | Close the window |
| `setFullscreen` | `fullscreen: boolean` | Enter or exit fullscreen mode |
| `isFullscreen` | — | Check whether the window is fullscreen |
| `getBounds` | — | Return `{ x, y, width, height }` for the window |
| `setBounds` | `bounds: Partial<Rectangle>` | Set the window position and/or size |
| `setOpacity` | `opacity: number` | Set window opacity (0–1) |
| `getOpacity` | — | Return the current window opacity |
| `setAlwaysOnTop` | `flag: boolean` | Pin or unpin the window above others |
| `isAlwaysOnTop` | — | Check whether always-on-top is active |
| `center` | — | Move the window to the center of the screen |
| `setTitle` | `title: string` | Set the window title bar text |

### Notification Methods

| Method | Parameters | Description |
|--------|-----------|-------------|
| `showNotification` | `config: NotificationConfig` | Show a system notification |
| `closeNotification` | `id: string` | Dismiss a specific notification |

### Power Methods

| Method | Parameters | Description |
|--------|-----------|-------------|
| `getPowerState` | — | Return battery level, charging state, and power source |

### App Methods

| Method | Parameters | Description |
|--------|-----------|-------------|
| `quit` | — | Quit the Electrobun application |
| `relaunch` | — | Relaunch the Electrobun application |
| `getVersion` | — | Return the application version string |
| `isPackaged` | — | Return whether the app is running from a packaged build |
| `getPath` | `name: string` | Return an Electrobun app path (e.g., `userData`, `logs`) |

### Clipboard Methods

| Method | Parameters | Description |
|--------|-----------|-------------|
| `writeToClipboard` | `text: string` | Write text to the system clipboard |
| `readFromClipboard` | — | Read text from the system clipboard |
| `clearClipboard` | — | Clear the system clipboard |

### Shell Methods

| Method | Parameters | Description |
|--------|-----------|-------------|
| `openExternal` | `url: string` | Open a URL in the default browser |
| `showItemInFolder` | `path: string` | Reveal a file in Finder/Explorer |
| `beep` | — | Play the system alert sound |

---

## @capacitor/haptics

Standard Capacitor haptics plugin. Provides impact, notification, and selection feedback patterns on iOS and Android. No-op on web and desktop.

```typescript
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";

await Haptics.impact({ style: ImpactStyle.Medium });
await Haptics.notification({ type: NotificationType.Success });
await Haptics.selectionStart();
await Haptics.selectionChanged();
await Haptics.selectionEnd();
```

---

## Related

- [Mobile App](/apps/mobile) — platform configuration, build targets, and project structure
- [Build Guide](/apps/mobile/build-guide) — how to compile plugins and produce signed iOS/Android builds
- [Native Modules](/apps/desktop/native-modules) — equivalent capability system for the Electrobun desktop app
