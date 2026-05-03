---
title: Desktop App (Electrobun)
sidebarTitle: Desktop App
description: Install and use the Eliza desktop application on macOS, Windows, and Linux with native features and configurable local or remote runtime connectivity.
---

The Eliza desktop app wraps the companion UI in a native Electrobun shell, adding system-level features like tray icons, global keyboard shortcuts, native notifications, and native OS capability bridges. Electrobun can either launch the canonical Eliza runtime locally or connect the UI to an already-running local or remote runtime.

## Download and Install

### macOS

Download the `.dmg` file from the [GitHub releases page](https://github.com/eliza-ai/eliza/releases). Open the DMG and drag Eliza to your Applications folder.

- **Which file:** On Apple Silicon (M1/M2/M3/M4 and later), use **Eliza-arm64.dmg**. On Intel Macs, use **Eliza-x64.dmg**. If you pick the wrong architecture, the app may not run correctly; see [Build & release — why two DMGs](/build-and-release#macos-why-two-dmgs-arm64-and-x64).
- **Build targets:** DMG and ZIP.
- **Category:** Productivity (`public.app-category.productivity`).
- **Code signed and notarized** -- hardened runtime with Apple notarization enabled.

### Windows

Download the `.exe` installer (NSIS) from the releases page.

- **Build target:** NSIS installer.
- **Options:** Choose installation directory, run elevated if needed.
- **Code signed** via Azure Code Signing (`eliza-code-sign` certificate profile).

### Linux

Download the `.AppImage` or `.deb` package from the releases page.

- **Build targets:** AppImage and deb.
- **Category:** Utility.

### Build from Source

```bash
git clone https://github.com/eliza-ai/eliza.git && cd eliza
bun install && bun run build
bun run dev:desktop
```

For **why** the desktop dev commands spawn multiple processes, how **Ctrl-C** and **Quit** behave, **environment variables** (`ELIZA_DESKTOP_VITE_WATCH`, `ELIZA_RENDERER_URL`, etc.), and **IDE/agent observability** (`GET /api/dev/stack`, aggregated console log, screenshot proxy — *why* loopback, defaults, and opt-out), see **[Desktop local development](./desktop-local-development)**.

In development mode, the Electrobun app resolves the Eliza distribution from the repository root's `dist/` directory. In packaged builds, assets are copied into the app bundle under `Resources/app/eliza-dist/`.

## macOS frameless window chrome (hiddenInset)

On **macOS**, the main window uses **`hiddenInset`** (no classic title bar; traffic lights inset). The WKWebView fills the client area, so **window move** and **inner-edge resize** are implemented with **native `NSView` overlays** above the web view — not with CSS resize cursors alone. **Why:** WebKit owns the pointer over page pixels; tracking areas on the `contentView` underneath led to unreliable cursors and flicker when AppKit and WebKit both tried to set `NSCursor`.

Strip **thickness** can track the current **`NSScreen`** when the host passes `height: 0` into native layout (see main-process `applyMacOSWindowEffects` and FFI `setNativeDragRegion`). Full architecture, z-order, and file map: [Electrobun macOS window chrome](/guides/electrobun-mac-window-chrome).

### WebGPU log line vs macOS version (Tahoe+)

Electrobun may log **`[WebGPU Browser] macOS …`** using **`os.release()`** (Darwin). **Why document:** on **macOS 26**, Darwin is still **25.x**; a naive `Darwin − 9` mapping shows **16** and mis-gates WKWebView WebGPU. Eliza maps Darwin to the **marketing** major in code; rationale and table: [Darwin vs macOS version (Electrobun WebGPU)](/apps/electrobun-darwin-macos-webgpu-version).

### Battery and energy use (macOS)

**Product framing:** Eliza targets **strong visuals when you are engaged** and **quiet hardware when you are not**—especially on battery—without pretending every workload beats a full IDE shell. See [Roadmap — Principles: energy and experience (desktop)](/roadmap#principles-energy-and-experience-desktop).

**What drives usage**

- **Continuous GPU work:** the companion **VRM** scene (WebGL or WebGPU) runs an animation/render loop while the scene is **active**. **Why it matters:** macOS attributes GPU time to the app even when you are not interacting; idle VRM + lighting + (optional) Spark/world effects are not free.
- **Multiple processes in dev:** `dev:desktop` / `dev:desktop:watch` run API + Vite + Electrobun (+ optional screenshot helper). **Why:** each process has its own baseline CPU wakeups; this is a dev convenience, not the same as a minimal shipped shell.
- **Dev screenshot proxy:** default-on **`GET /api/dev/cursor-screenshot`** path uses **full-screen capture** when agents poll it. **Why:** `screencapture` and compositor work are noticeable if something hits that endpoint often — turn it off when you do not need it (`ELIZA_DESKTOP_SCREENSHOT_SERVER=0`); see [Desktop local development](./desktop-local-development).

**What Eliza already does**

- **Pauses the avatar engine** when the companion scene is not active (`VrmEngine.setPaused` / `VrmViewer`), e.g. when you leave companion mode for native tabs (settings, chat shell) so the 3D loop is not running in the background for those routes. **Why:** `requestAnimationFrame` / `setAnimationLoop` at display refresh is the main avoidable steady-state cost.
- **Page Visibility:** `VrmViewer` also pauses when **`document.visibilityState !== "visible"`** (background tab / hidden document). **Why:** WKWebView can keep scheduling frames for a visible canvas; aligning with visibility avoids burning GPU when the user is not looking at Eliza.
- **Background tab polling:** dashboard/stream/game/fine-tuning views use **`useIntervalWhenDocumentVisible`** (or equivalent) so **5s / 3s** refresh timers do not hit the API while the document is hidden. Eliza Cloud **credits** polling (**60s**) skips work when hidden. **Why:** same battery/thermal story as the VRM loop, for network + React wakeups.
- **Vector memory 3D graph:** the Three.js **`requestAnimationFrame`** loop **stops while the tab is hidden** and resumes on **visible**. **Why:** second WebGL context should not animate off-screen.
- **Battery → lower pixel ratio (Electrobun):** the UI calls **`desktop:getPowerState`** on a **60s** timer, when the renderer becomes ready, and when **`document.visibilityState`** returns to **visible** (so plugging in is noticed without waiting for the next interval). When **`onBattery`** is true, `VrmEngine.setLowPowerRenderMode` caps effective DPR at **1×** on top of the usual `MAX_RENDERER_PIXEL_RATIO` clamp. **Why:** fewer shaded pixels when unplugged (e.g. HiDPI laptops). The main process resolves AC vs battery using **`pmset`** on **macOS**, **`/sys/class/power_supply`** (Battery + `Discharging`) on **Linux**, and **`SystemInformation.PowerStatus.PowerLineStatus`** on **Windows** (`Offline` = on battery). **Opt-out:** set **localStorage** **`eliza.vrmBatteryPixelCap`** to **`"0"`** to keep full resolution on battery (user **Companion efficiency** in Settings → Media can still request low-power on AC).
- **Companion rendering (Settings → Media):** persisted **`eliza:companion-vrm-power`** is **`quality`** (never battery low-power), **`balanced`** (low-power on battery when the cap is on), or **`efficiency`** (always low-power). Legacy boolean keys migrate once.
- **Animate in background** (opt-in, **`eliza:companion-animate-when-hidden`**): when the window or tab is hidden but companion is still the active scene, the engine stays unpaused and **only the world + Spark are hidden** so the VRM can idle with lower cost than drawing the full splat scene.
- **Battery → Spark + shadows:** on battery, **`setLowPowerRenderMode`** also **disables directional shadow maps** on the avatar key light and applies **tighter Spark splat limits** (`maxPixelRadius`, `minAlpha`, sort distance, etc.). **Why:** shadows and splat sorting are a large share of GPU time in companion/world mode.
- **Half framerate:** **`VrmEngine.setHalfFramerateMode`** skips every other main-loop tick (skipped ticks do not advance `Clock`, so the next tick’s delta is doubled). **`setLowPowerRenderMode`** is separate (DPR / shadows / Spark). Default policy ties half-FPS to “saving power” moments; Settings → Media can set **full speed**, **when saving power**, or **always half**.
- **Lazy-mounts** the 3D stack the first time the companion scene is needed, and defers it while the agent is still **`starting`** / onboarding is loading. **Why:** avoids paying WebGL/WebGPU init during the boot path when the UI only needs status and loaders.
- **Caps renderer pixel ratio** (see `MAX_RENDERER_PIXEL_RATIO` in `VrmEngine`) so Retina does not always mean **2×** shader cost at **3×** physical pixels.

**What you can do today**

- Use **native shell** (non-companion) when you mostly want chat/settings without the full-screen avatar. **Why:** `companionSceneActive` stays tied to shell/tab state, so the heavy scene is off when you are not in companion or character flows.
- If WebGPU is hotter on your Mac than WebGL for this workload, set the renderer override in **localStorage** key **`eliza.avatarRenderer`** to **`webgl`** (or **`webgpu`** to experiment the other way). **Why:** path differs by machine and OS version; the desktop webview defaults WebGPU in the Electrobun runtime — sometimes the fallback is kinder to thermals.
- In dev, disable the **screenshot** and **aggregated console** hooks if you do not use them (`ELIZA_DESKTOP_SCREENSHOT_SERVER`, `ELIZA_DESKTOP_DEV_LOG`).

**Code:** `eliza/packages/app-core/src/hooks/useDocumentVisibility.ts`, `VectorBrowserView.tsx` (3D graph), `ElizaCloudDashboard.tsx`, `StreamView.tsx`, `stream/StreamVoiceConfig.tsx`, `GameView.tsx`, `ChatView.tsx` (game-modal carryover timer), `FineTuningView.tsx`, `state/AppContext.tsx` (cloud credits interval), `VrmViewer.tsx`, `VrmEngine.ts`, `vrm-desktop-energy.ts`.

## Desktop Runtime Modes

Electrobun is a native shell, not a separate runtime architecture. Desktop, VPS, sandboxed, and CLI/server deployments all use the same Eliza runtime entrypoint. The shell chooses one of three runtime modes at startup:

| Mode | Behavior |
|------|----------|
| `local` | Spawn the canonical Eliza runtime locally as a child Bun process |
| `external` | Do not spawn a local runtime; point the renderer at an explicit API base |
| `disabled` | Do not auto-start a local runtime; still point the renderer at the expected local API base for a manually managed server |

### Startup Sequence

On startup, the Electrobun shell and `AgentManager` coordinate these steps:

1. **Resolve the runtime bundle** -- In dev mode, Electrobun finds the repository root `dist/` bundle. In packaged builds, the runtime is copied into `Resources/app/eliza-dist/`.
2. **Resolve desktop runtime mode** -- Environment variables decide whether the shell should use `local`, `external`, or `disabled` runtime mode.
3. **Bootstrap the renderer with an API base** -- The static renderer server injects `window.__ELIZA_API_BASE__` into `index.html` before React mounts so the UI never falls back to the static server for `/api/*` requests.
4. **If mode is `local`, spawn the canonical runtime** -- Electrobun launches `bun run entry.js start` as a child process, waits for `/api/health`, and then pushes the actual bound port to the renderer.
5. **If mode is `external`, connect only** -- Electrobun does not start a child runtime. The renderer uses the normalized external API base and optional API token.
6. **If mode is `disabled`, wait for a manually managed local runtime** -- Electrobun does not auto-start the child runtime, but the renderer still targets the expected local API base so a separately managed server can satisfy requests.

### Port Configuration

**Embedded `local` mode (packaged or dev without external API):** the Electrobun main process chooses a **listen port** for the child **`eliza start`** process as follows:

1. **Preferred port** — `ELIZA_PORT` (default **2138**). The shell probes **127.0.0.1** and, if that port is busy, uses the **next free** port (same idea as `dev-platform`, implemented in `loopback-port.ts`). **Why:** two Eliza instances or another service may legitimately hold **2138**; we should not SIGKILL unrelated processes by default (see **`ELIZA_AGENT_RECLAIM_STALE_PORT`** in [Desktop local development](/apps/desktop-local-development#when-default-ports-are-busy) to opt back into reclaim).
2. **Child env** — the spawned process receives the chosen port via **`ELIZA_PORT`** so `entry.js start` binds there when possible.
3. **Stdout + health** — if the runtime still reports a different bind (legacy / upstream behavior), stdout parsing and **`waitForHealthy`** follow the **actual** port before marking the agent running.
4. **Renderer + surfaces** — `pushApiBaseToRenderer` / `injectApiBase` use **`AgentManager`’s resolved port**; status listeners refresh **main and detached** windows. **Why:** the dashboard must not keep using a stale loopback URL after a dynamic bind.

**`external` mode:** no embedded child; the UI uses **`ELIZA_DESKTOP_API_BASE`** / related env (e.g. dev-platform sets this to **`http://127.0.0.1:<resolved API port>`**). **Why:** the API may already be running under **`bun run dev`** with its own port policy.

**`disabled` mode:** no auto-start; the renderer still targets the **expected** local API base for a process you manage yourself—set **`ELIZA_PORT`** / **`ELIZA_API_PORT`** to match that server.

**CLI `eliza start` (non-Electrobun):** after `startApiServer` returns, Eliza syncs **`ELIZA_PORT`** and **`ELIZA_API_PORT`** to the **actual** bound port. **Why:** if the HTTP stack falls forward to another port, shells and scripts reading env see the same port as **`/api/health`**.

### Native application menu (e.g. macOS **Eliza** menu)

The OS menu bar template is built in **`apps/app/electrobun/src/application-menu.ts`** and wired in **`index.ts`** (`application-menu-clicked`). **Why a data file:** the same structure is validated by tests and stays free of platform branches scattered through the main process.

| Item (example) | Action id | Behavior |
|----------------|-----------|----------|
| **Reset Eliza…** | `reset-eliza` | **Main process:** shows the window, native confirm, then **`POST /api/agent/reset`**, embedded restart or **`POST /api/agent/restart`**, poll **`/api/status`**, and pushes **`desktopTrayMenuClick`** with **`itemId: "menu-reset-eliza-applied"`** + **`agentStatus`**. **Renderer:** **`handleResetAppliedFromMain`** runs the same **local UI wipe** as the end of Settings **`handleReset`** (`completeResetLocalStateAfterServerWipe`). **Why main owns HTTP:** after native dialogs, WKWebView can defer renderer **`fetch`/bridge** work, so reset looked hung; **why renderer still wipes UI:** one place for onboarding, `ElizaClient` base URL, cloud flags, and conversation lists so the menu cannot drift from Settings. |

**Settings** still uses **`handleReset`** (webview confirm + full flow). **Legacy:** tray may still emit **`menu-reset-eliza`** for older paths; see [Desktop main-process reset](/apps/desktop-main-process-reset) for sequence, probes, and tests.

### Agent Status States

The embedded agent reports its state to the UI via IPC:

| State | Meaning |
|-------|---------|
| `not_started` | Agent has not been started yet |
| `starting` | Agent is initializing (API server may already be available) |
| `running` | Agent is active and accepting requests |
| `stopped` | Agent has been shut down |
| `error` | Agent encountered a fatal error |

### Runtime Mode Overrides

For testing, remote connectivity, or locally managed runtime workflows:

| Environment Variable | Effect |
|---------------------|--------|
| `ELIZA_DESKTOP_TEST_API_BASE` | Use this API base and switch to `external` mode |
| `ELIZA_DESKTOP_API_BASE` | Use this API base and switch to `external` mode |
| `ELIZA_API_BASE_URL` / `ELIZA_API_BASE` | Generic API-base fallback vars; also switch to `external` mode |
| `ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT=1` | Switch to `disabled` mode; do not auto-start the child runtime |
| `ELIZA_API_TOKEN` | Inject an API authentication token into the renderer |

## Native Modules

The desktop app registers **10 native modules** via IPC, each providing platform-specific capabilities. All modules are initialized in `initializeNativeModules()` and their IPC handlers are registered in `registerAllIPC()`. Every module follows a singleton pattern with a dedicated manager class.

### Agent

Local embedded runtime management via the `AgentManager` class.

| IPC Channel | Description |
|------------|-------------|
| `agent:start` | Start the local child runtime when desktop mode is `local` |
| `agent:stop` | Stop the local child runtime |
| `agent:restart` | Stop and restart the runtime, picking up config changes |
| `agent:status` | Get the current `AgentStatus` object |

In `external` and `disabled` mode, `agent:start` rejects instead of spawning the embedded runtime. The agent also emits `agent:status` events to the renderer whenever local-runtime state changes.

### Desktop Manager

Core native desktop features via the `DesktopManager` class. This is the largest module, covering eight subsystems:

**System Tray** -- Create, update, and destroy tray icons with context menus. Supports tooltip, title (macOS), icons for menu items, and submenus. Tray events (`click`, `double-click`, `right-click`) are forwarded to the renderer with modifier key state and cursor coordinates.

**Global Keyboard Shortcuts** -- Register system-wide hotkeys that work even when the app is not focused. Each shortcut has a unique ID and an desktop accelerator string. When pressed, a `desktop:shortcutPressed` event is sent to the renderer.

| IPC Channel | Description |
|------------|-------------|
| `desktop:registerShortcut` | Register a global shortcut by ID and accelerator |
| `desktop:unregisterShortcut` | Unregister a shortcut by ID |
| `desktop:unregisterAllShortcuts` | Remove all registered shortcuts |
| `desktop:isShortcutRegistered` | Check if an accelerator is currently registered |

**Auto-Launch** -- Configure the app to start on system login, optionally hidden, via `desktop:setAutoLaunch` and `desktop:getAutoLaunchStatus`.

**Window Management** -- Programmatic control over the main window. Supports size, position, min/max dimensions, resizability, always-on-top, fullscreen, opacity, vibrancy (macOS), background color, and more. Window events (`focus`, `blur`, `maximize`, `minimize`, `restore`, `close`) are forwarded to the renderer.

**Native Notifications** -- Rich notifications with actions, reply support, urgency levels, and click handling. Each notification gets a unique auto-incremented ID. Supports `click`, `action`, `reply`, and `close` event callbacks forwarded to the renderer.

**Power Monitoring** -- Battery state, idle time detection, and suspend/resume events. Emits `desktop:powerSuspend`, `desktop:powerResume`, `desktop:powerOnAC`, and `desktop:powerOnBattery` events.

**Clipboard Operations** -- Read and write text, HTML, RTF, and images to the system clipboard.

**Shell Operations** -- Open external URLs in the default browser, reveal files in Finder/Explorer, and trigger system beeps.

### Gateway Discovery

Network discovery for finding Eliza gateway servers on the local network via the `GatewayDiscovery` class. Uses mDNS/Bonjour for service discovery with the `_eliza._tcp` service type.

The module dynamically loads discovery libraries in priority order:
1. **mdns** (native, faster)
2. **bonjour-service** (pure JS, more portable)
3. **bonjour** or **mdns-js** (fallback alternatives)

Discovered gateways include metadata from TXT records: stable ID, TLS configuration, gateway port, canvas port, and Tailnet DNS name. Events (`found`, `updated`, `lost`) are forwarded to the renderer via `gateway:discovery`.

| IPC Channel | Description |
|------------|-------------|
| `gateway:startDiscovery` | Begin scanning with optional service type and timeout |
| `gateway:stopDiscovery` | Stop active discovery |
| `gateway:getDiscoveredGateways` | List all currently known gateways |
| `gateway:isDiscovering` | Check if discovery is active |

### Talk Mode

Full conversation mode via the `TalkModeManager` class, integrating speech-to-text (STT) and text-to-speech (TTS).

**STT Engines:**
- **Whisper** (default) -- Offline speech recognition using `whisper-node` with configurable model sizes: `tiny`, `base`, `small`, `medium`, `large`. Supports word-level timing and streaming transcription.
- **Web Speech API** -- Falls back to the browser's built-in speech recognition when Whisper is unavailable.

**TTS Engines:**
- **ElevenLabs** -- High-quality streaming TTS via the ElevenLabs API. Configurable voice ID, model ID (default: `eleven_v3`), stability, similarity boost, and speed. Audio chunks are streamed to the renderer as base64-encoded data.
- **System TTS** -- Falls back to the renderer's browser speech synthesis.

**Voice Activity Detection (VAD):** Configurable silence threshold and duration for automatic speech segmentation.

| State | Meaning |
|-------|---------|
| `idle` | Talk mode is off |
| `listening` | Actively capturing and transcribing audio |
| `processing` | Processing captured speech |
| `speaking` | TTS is playing audio |
| `error` | An error occurred |

Audio data flows from the renderer to the main process via `talkmode:audioChunk` IPC messages as `Float32Array` samples.

### Swabble (Voice Wake)

Wake word detection for hands-free activation via the `SwabbleManager` class. Uses Whisper for continuous speech transcription combined with a `WakeWordGate` that performs timing-based wake word matching.

**Configuration:**
- `triggers` -- Array of wake word phrases (e.g., `["eliza", "hey eliza"]`)
- `minPostTriggerGap` -- Minimum pause (seconds) after the wake word before the command starts (default: 0.45s)
- `minCommandLength` -- Minimum number of words in the command after the wake word (default: 1)
- `modelSize` -- Whisper model size to use

The wake word gate includes **fuzzy matching** for common transcription variations (e.g., "melody" matches "eliza", "okay" matches "ok").

When a wake word is detected, a `swabble:wakeWord` event is sent to the renderer containing the matched trigger, extracted command, full transcript, and the post-trigger gap measurement.

### Screen Capture

Native screenshot and screen recording via the `ScreenCaptureManager` class.

**Screenshots:** Capture the primary screen, a specific source, or the main window. Supports PNG and JPEG formats with configurable quality. Screenshots can be saved to the user's Pictures directory.

**Screen Recording:** Uses a hidden `BrowserWindow` renderer for `MediaRecorder`-based recording (since MediaRecorder requires a renderer context). Supports configurable quality presets, FPS, bitrate, system audio, and max duration auto-stop. Recordings are saved as WebM (VP9 preferred) to the system temp directory.

| Quality | Bitrate |
|---------|---------|
| `low` | 1 Mbps |
| `medium` | 4 Mbps |
| `high` | 8 Mbps |
| `highest` | 16 Mbps |

Recording supports pause/resume and provides real-time state updates including duration and file size.

### Camera

Camera capture for photo and video via the `CameraManager` class. Like screen recording, this uses a hidden `BrowserWindow` renderer for `getUserMedia` / `MediaRecorder` access.

**Features:**
- Device enumeration with direction detection (front/back/external)
- Live preview with configurable resolution and frame rate
- Photo capture in JPEG, PNG, or WebP with quality control
- Video recording with configurable quality, bitrate, audio, and max duration
- Permission checking and requesting

| Quality | Video Bitrate |
|---------|--------------|
| `low` | 1 Mbps |
| `medium` | 2.5 Mbps |
| `high` | 5 Mbps |
| `highest` | 8 Mbps |

### Canvas

Auxiliary `BrowserWindow` management via the `CanvasManager` class. Each canvas is a separate window used for web navigation, JavaScript evaluation, page snapshots, and A2UI (Agent-to-UI) message injection.

| IPC Channel | Description |
|------------|-------------|
| `canvas:createWindow` | Create a new canvas window (default 1280x720, hidden) |
| `canvas:destroyWindow` | Close and dispose a canvas window |
| `canvas:navigate` | Navigate a canvas to a URL |
| `canvas:eval` | Execute JavaScript in the canvas page |
| `canvas:snapshot` | Capture a screenshot (supports sub-rectangles) |
| `canvas:a2uiPush` | Inject an A2UI message payload |
| `canvas:a2uiReset` | Reset A2UI state on the page |
| `canvas:show` / `canvas:hide` | Toggle visibility |
| `canvas:resize` | Resize with optional animation |
| `canvas:listWindows` | List all active canvas windows |

Canvas windows emit `canvas:didFinishLoad`, `canvas:didFailLoad`, and `canvas:windowClosed` events to the main renderer.

### Location

GPS and geolocation services via the `LocationManager` class using IP-based geolocation.

<Info>
Native platform location APIs (CoreLocation on macOS, Windows.Devices.Geolocation on Windows) require native Node.js addons not currently implemented. IP-based geolocation provides approximately 5km accuracy. For higher accuracy, the renderer should use the browser's Geolocation API, which accesses native location services through Chromium.
</Info>

The module queries multiple IP geolocation services as fallbacks: `ip-api.com`, `ipapi.co`, and `freegeoip.app`. It supports single position queries, position watching (polling at configurable intervals), and caching of the last known location.

### Permissions

System permission management via the `PermissionManager` class with platform-specific implementations for macOS, Windows, and Linux.

**Managed permissions:**

| Permission ID | Name | Platforms | Required For |
|--------------|------|-----------|-------------|
| `accessibility` | Accessibility | macOS | Computer use, browser control |
| `screen-recording` | Screen Recording | macOS | Computer use, vision |
| `microphone` | Microphone | All | Talk mode, voice |
| `camera` | Camera | All | Camera, vision |
| `shell` | Shell Access | All | Shell/terminal commands |

Permission states are cached for 30 seconds (configurable). The shell permission includes a soft toggle -- it can be disabled in the UI without affecting the OS-level permission.

IPC channels include `permissions:getAll`, `permissions:check`, `permissions:request`, `permissions:openSettings`, `permissions:checkFeature`, and `permissions:setShellEnabled`.

## Global Shortcuts

The desktop app registers these global keyboard shortcuts:

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+K` | Open the Command Palette |
| `Cmd/Ctrl+E` | Open the Emote Picker |

These shortcuts work system-wide when the app is running. Additional shortcuts can be registered dynamically via the `desktop:registerShortcut` IPC channel.

## Deep Linking

The desktop app supports the `eliza://` custom URL protocol for deep linking. The protocol is registered via the Electrobun deep linking integration.

### Share Target

The `eliza://share` URL scheme allows external applications to share content with your agent:

```
eliza://share?title=Hello&text=Check+this+out&url=https://example.com
```

**Parameters:**
- `title` -- optional title for the shared content.
- `text` -- optional text body.
- `url` -- optional URL to share.
- `file` -- one or more file paths (can be repeated).

File drag-and-drop from the OS is also supported via the desktop runtime `open-file` event. Share payloads are queued if the main window is not yet ready and flushed once the renderer finishes loading. Events are dispatched as `eliza:share-target` custom DOM events.

## Auto-Updater

The desktop app checks for updates on launch via the Electrobun updater, publishing to GitHub releases under the `eliza-ai/eliza` repository.

## Development Mode

In development mode:

- A **file watcher** (chokidar) monitors the web asset directory and auto-reloads the app when files change (1.5-second debounce).
- Content Security Policy is adjusted for development -- `localhost` and `devtools://*` origins are allowed for scripts.
- DevTools open automatically on DOM ready.

## Security Considerations

<Warning>
The desktop app runs with full system access. Be cautious with plugins and custom actions that execute shell commands or access the filesystem.
</Warning>

- **Content Security Policy** -- Applied to all windows. The policy is intentionally permissive to support third-party embedded apps that may require WebAssembly and external scripts.
- **Window navigation** -- External URLs are blocked from the main window and opened in the default browser. Only the custom scheme and localhost origins are allowed.
- **Context isolation** -- All `BrowserWindow` instances use `contextIsolation: true` and `nodeIntegration: false`.
- **SSRF protection** -- Custom action HTTP handlers block requests to private/internal network addresses. See [Custom Actions](/guides/custom-actions).
