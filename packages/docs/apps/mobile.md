---
title: Mobile App (iOS/Android)
sidebarTitle: Mobile App
description: Run Eliza on iOS and Android devices using the Capacitor-based mobile app with native plugin support.
---

The Eliza mobile app brings the full dashboard experience to iOS and Android devices using [Capacitor](https://capacitorjs.com/), a cross-platform native runtime. The same web UI runs inside a native WebView with access to device hardware through Capacitor plugins.

## Runtime Policy

iOS App Store and Google Play builds are Cloud-backed mobile clients. They do
not run a local Bun backend, local shell, PTY-spawned Claude/Codex/OpenCode, or
the privileged AOSP agent service in-app. Local generated applets run through
the mobile-safe runtime and virtual file system only. JSCore, QuickJS,
Android isolated-process, and AVF providers are advertised only when an actual
native boundary is attached; otherwise the app falls back to VFS/WASM-safe
surfaces and Cloud containers.

The AOSP / ElizaOS Android build is a separate privileged system target. It can
stage the on-device Bun agent, `/system/bin/sh`, shell plugin, coding-tools
plugin, agent orchestrator, and optional AVF/Microdroid boundary when the
device image exposes those APIs. The Android template includes a reflection-only
AVF probe, but the Microdroid payload/RPC lifecycle is still AOSP-only follow-up
work. Claims about AOSP terminal behavior remain tracked as TODO-AOSP-PTY and
TODO-AOSP-TOOLCHAIN in
[`docs/mobile-agentic-ide-platform-plan.md`](../../../docs/mobile-agentic-ide-platform-plan.md).

Use `bun run build:android:cloud` from the repository root for a Play-store
style release AAB thin client; `android-cloud-debug` is only for debug APK
iteration. Use `bun run build:android:system` for the privileged AOSP APK. The
legacy `packages/app` `build:android` script is sideload-only and embeds the
on-device agent runtime. The cloud target strips the local agent, privileged
default-role surfaces, staged runtime assets, native runtime plugin references,
`MANAGE_APP_OPS_MODES`, `MANAGE_VIRTUAL_MACHINE`, and other system-only
permissions, then audits the source tree and artifact.

## Platform Support

| Platform | Minimum Version | Scheme | Notes |
|----------|----------------|--------|-------|
| **iOS** | iOS 14+ (armv7) | HTTPS | Automatic content inset, mobile-preferred content mode, link preview disabled |
| **Android** | API 26 (Android 8.0+) | HTTPS | Input capture enabled, mixed content disabled, WebContents debugging off in production |

**App ID:** `com.elizaai.eliza`
**Package name:** `@elizaai/app`
**Current version:** `2.0.0-alpha.87`

## Prerequisites

### iOS

- **macOS** (required for iOS development)
- **Xcode 15+** with iOS platform tools installed
- **CocoaPods** (Capacitor uses it for native dependencies): `sudo gem install cocoapods`
- An Apple Developer account for device testing and distribution
- For simulator testing, no signing is required

### Android

- **Android Studio** (any recent version)
- **Android SDK** with API level 35 (compileSdk) installed via SDK Manager
- **JDK 17+** (bundled with recent Android Studio)
- A physical device or emulator with API 26+

### Shared

- **Node.js 22+** and the project's package manager (Bun)
- The monorepo cloned and dependencies installed at the root level

## Building the App

All mobile build commands run from the **repository root** using `bun run`.

### Build for iOS

```bash
# Build plugins, web assets, and sync to the iOS project
bun run build:ios

# Open the Xcode project
bun run cap:open:ios
```

This runs `vite build` to produce the `dist/` web assets, then `capacitor sync ios` to copy them into the native iOS project and update native dependencies.

The Xcode workspace is at `packages/app/ios/App/App.xcworkspace`.

### Build for Android

```bash
# Build plugins, web assets, and sync to the Android project
bun run build:android

# Open the Android Studio project
bun run cap:open:android
```

This runs `vite build` followed by `capacitor sync android` to copy web assets and update the Gradle project.

The Android project is at `packages/app/android/`.

### Build Plugins Only

All custom Capacitor plugins must be built before the web app can bundle them:

```bash
bun run plugin:build
```

This iterates through each plugin directory (`gateway`, `swabble`, `camera`, `screencapture`, `canvas`, `desktop`, `location`, `talkmode`, `agent`, `appblocker`, `llama`, `mobile-signals`, `websiteblocker`) and runs the build script for each.

### Sync Without Rebuilding

If you have already built the web assets and only need to push changes to the native projects:

```bash
cd packages/app

# Sync all platforms
bun run cap:sync

# Sync iOS only
bun run cap:sync:ios

# Sync Android only
bun run cap:sync:android
```

## Platform Configuration

The shared Capacitor configuration lives in `capacitor.config.ts`. Mobile targets use that shared config, while the desktop runtime is configured alongside the Electrobun app.

### Configuration Fields

```typescript
{
  appId: "com.elizaai.eliza",
  appName: "Eliza",
  webDir: "dist",
  server: {
    androidScheme: "https",
    iosScheme: "https",
    allowNavigation: [
      "localhost", "127.0.0.1",
      "*.elizacloud.ai", "app.eliza.ai", "cloud.eliza.ai", "*.eliza.ai",
      "rs-sdk-demo.fly.dev", "*.fly.dev",
      "hyperscape.gg", "*.hyperscape.gg",
    ],
  },
  plugins: {
    Keyboard: { resize: "body", resizeOnFullScreen: true },
  },
  ios: {
    contentInset: "automatic",
    preferredContentMode: "mobile",
    backgroundColor: "#0a0a0a",
    allowsLinkPreview: false,
  },
  android: {
    backgroundColor: "#0a0a0a",
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
}
```

| Field | Purpose |
|-------|---------|
| `webDir` | Directory containing the bundled Vite output (`dist`) |
| `server.allowNavigation` | Domains the WebView is allowed to navigate to (localhost, Eliza Cloud, game servers, etc.) |
| `server.androidScheme` / `iosScheme` | Both set to HTTPS for secure WebView content loading |
| `plugins.Keyboard.resize` | Body resize mode keeps the chat input visible when the keyboard opens |
| `ios.contentInset` | Automatic insets for the notch / Dynamic Island |
| `ios.preferredContentMode` | Mobile-optimized rendering (not desktop-style) |
| `ios.allowsLinkPreview` | Disables long-press link previews that interfere with custom gestures |
| `android.captureInput` | The WebView captures all input events (prevents Android back gesture conflicts) |
| `android.allowMixedContent` | Disabled to prevent insecure HTTP resources in the HTTPS WebView |
| `android.webContentsDebuggingEnabled` | Disabled in production for security (enable for development) |

## Capacitor Plugins

The mobile app uses 13 custom Eliza Capacitor plugins plus the core Haptics plugin, each providing native capabilities with web fallbacks.

### 1. Gateway (`@elizaos/capacitor-gateway`)

Connects the mobile app to a Eliza agent running elsewhere on the network.

- **Discovery:** Native Bonjour/mDNS discovery scans for `_eliza-gw._tcp` services on the local network. Supports both local discovery and wide-area DNS-SD (e.g., over Tailscale).
- **WebSocket:** Real-time RPC communication with authentication, reconnection, and event streaming.
- **Authentication:** Supports token-based and password-based auth with configurable client name, version, session key, role, and scopes.
- **Events:** Streams `gatewayEvent`, `stateChange`, `error`, and `discovery` events.
- On web, discovery falls back to manual connection; WebSocket works natively in the browser.

### 2. Swabble (`@elizaos/capacitor-swabble`)

Voice wake-word detection for hands-free activation.

- **Wake words:** Configurable trigger words (e.g., `["eliza"]`) with post-trigger gap detection and minimum command length.
- **Continuous listening:** Only available on native platforms (iOS/Android). Uses the native Speech framework on iOS, SpeechRecognizer on Android, and Whisper.cpp on desktop.
- **Audio levels:** Streams real-time audio level events for visualization.
- **Transcript events:** Provides speech segments with timing information and confidence scores.
- On web, falls back to the Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`) if available.

### 3. Talk Mode (`@elizaos/capacitor-talkmode`)

Full speech pipeline: speech-to-text, chat with agent, text-to-speech response.

- **STT engines:** Native speech recognition or Whisper (configurable model sizes: tiny, base, small, medium, large).
- **ElevenLabs TTS:** Available on all platforms with configurable voice ID, model, speed, stability, similarity boost, style exaggeration, language, and latency tier.
- **System TTS:** Native speech synthesis on iOS/Android; Web Speech Synthesis API on web. Used as automatic fallback if ElevenLabs is unavailable.
- **Interrupt on speech:** Stops TTS playback when the user starts speaking.
- **State machine:** Cycles through `idle` -> `listening` -> `processing` -> `speaking` with event listeners for each transition.
- **Permissions:** Checks and requests microphone and speech recognition permissions.

### 4. Camera (`@elizaos/capacitor-camera`)

Full camera control with preview, photo capture, and video recording.

- **Device enumeration:** Lists front, back, and external cameras with resolution and frame rate capabilities.
- **Live preview:** Renders camera feed into an HTML element with mirror option.
- **Photo capture:** Configurable quality, format (JPEG/PNG/WebP), dimensions, EXIF orientation, and gallery save.
- **Video recording:** Quality presets (low/medium/high/highest), max duration/size limits, bitrate, frame rate, and audio toggle.
- **Manual controls:** Zoom, focus point, exposure point, flash mode, white balance, and ISO.
- On web, falls back to `navigator.mediaDevices.getUserMedia`.

### 5. Location (`@elizaos/capacitor-location`)

GPS and geolocation services.

- **Accuracy levels:** best, high, medium, low, passive.
- **Single position:** `getCurrentPosition` with cache age and timeout options.
- **Continuous watch:** `watchPosition` with minimum distance and interval filters.
- **Background location:** Available on iOS/Android only (not on Electrobun). Requires separate permission grant.
- On web, uses the browser Geolocation API.

### 6. Screen Capture (`@elizaos/capacitor-screencapture`)

Screenshot and screen recording.

- **Screenshots:** Capture in PNG/JPEG/WebP with quality and scale options. Optional system UI capture.
- **Recording:** Configurable quality, FPS, bitrate, max duration/size, audio capture (system and microphone), and touch indicators.
- **Pause/resume:** Recording can be paused and resumed.
- Native platforms only for screenshots. Recording also available on web via `getDisplayMedia`.

### 7. Canvas (`@elizaos/capacitor-canvas`)

Canvas rendering and web view management. Available on all platforms (HTML Canvas API is universal).

- **Drawing primitives:** Rectangles, ellipses, lines, paths, text, and images with fill, stroke, gradient, shadow, and blend mode support.
- **Layer system:** Create, update, delete, and composite named layers with opacity and z-index.
- **Batch drawing:** Send multiple draw commands in a single call for performance.
- **Web view:** Navigate URLs, evaluate JavaScript, take snapshots, and push A2UI messages.
- **Deep links:** Intercepts `eliza://` URLs and fires `deepLink` events.
- **Touch input:** Streams multi-touch events with force data.

### 8. Agent (`@elizaos/capacitor-agent`)

Agent lifecycle management.

- **Cross-platform:** Uses IPC to the main-process AgentManager on Electrobun, and HTTP calls to the API server on iOS/Android/Web.
- **Lifecycle:** Start, stop, and query agent status (`not_started`, `starting`, `running`, `stopped`, `error`).
- **Chat:** Send text messages and receive agent responses.

### 9. Desktop (`@elizaos/capacitor-desktop`)

Desktop-specific features (macOS/Electrobun only):

- **System tray:** Create, update, and destroy with custom icons, tooltips, and context menus.
- **Global shortcuts:** Register accelerator-based keyboard shortcuts with press events.
- **Window management:** Resize, move, minimize, maximize, fullscreen, opacity, always-on-top, and vibrancy.
- **Auto launch:** Configure launch-on-startup with hidden option.
- **Notifications:** Rich notifications with actions, reply, and urgency levels.
- **Power monitor:** Battery level, charging state, and idle detection.
- **Clipboard:** Read/write text, HTML, RTF, and images.
- **Shell:** Open external URLs, show items in Finder/Explorer.

Not available on iOS/Android — these features are silently unavailable on mobile.

### 10. App Blocker (`@elizaos/capacitor-appblocker`)

App blocking for focus/productivity features (LifeOps). Allows the agent to block distracting apps on the user's device.

- Available on native platforms only.

### 11. Llama (`@elizaos/capacitor-llama`)

On-device LLM inference via `llama-cpp-capacitor`. Enables local model execution without network access.

- Available on native platforms with sufficient hardware.

### 12. Mobile Signals (`@elizaos/capacitor-mobile-signals`)

Mobile-specific signal handling and lifecycle events.

- Available on iOS and Android only.

### 13. Website Blocker (`@elizaos/capacitor-websiteblocker`)

Website blocking for focus/productivity features (LifeOps). Allows the agent to block distracting websites.

- Available on native platforms only.

### 14. Haptics (`@capacitor/haptics`)

Native haptic feedback for touch interactions (core Capacitor plugin, not custom).

- **Impact feedback:** Light, medium, heavy intensities.
- **Notification feedback:** Success, warning, error patterns.
- **Selection feedback:** Start, changed, end for pickers and sliders.
- Available on iOS and Android only. Calls are silently ignored on web.

## Plugin Bridge Layer

The plugin bridge provides a unified interface to all plugins with automatic platform detection and error handling.

### Capability Detection

Each plugin reports its capabilities for the current platform. The capabilities are computed at initialization time based on `Capacitor.getPlatform()` and web API detection:

```typescript
interface PluginCapabilities {
  gateway: { available, discovery, websocket }
  voiceWake: { available, continuous }
  talkMode: { available, elevenlabs, systemTts }
  camera: { available, photo, video }
  location: { available, gps, background }
  screenCapture: { available, screenshot, recording }
  canvas: { available }
  desktop: { available, tray, shortcuts, menu }
}
```

### Feature Availability

Check individual features programmatically:

```typescript
import { isFeatureAvailable } from "./bridge/plugin-bridge";

isFeatureAvailable("gatewayDiscovery"); // true on native
isFeatureAvailable("voiceWake");        // true on native or with Web Speech API
isFeatureAvailable("talkMode");         // true on native or with Web Speech API
isFeatureAvailable("elevenlabs");       // true everywhere (web API call)
isFeatureAvailable("camera");           // true on native or with getUserMedia
isFeatureAvailable("location");         // true if navigator.geolocation exists
isFeatureAvailable("backgroundLocation"); // true on iOS/Android only
isFeatureAvailable("screenCapture");    // true on native or with getDisplayMedia
isFeatureAvailable("desktopTray");      // true on Electrobun only
```

### Plugin Wrapping

Every plugin is wrapped in a `Proxy` that catches and logs errors from any method call. The wrapper interface exposes:

```typescript
interface WrappedPlugin<T> {
  plugin: T;       // The actual plugin instance
  isNative: boolean; // Whether the native implementation is available
  hasFallback: boolean; // Whether a web fallback exists
}
```

### Platform Fallbacks

When a native plugin is unavailable, the bridge provides graceful degradation:

- **Camera** falls back to `getUserMedia`.
- **Location** falls back to the browser Geolocation API.
- **Voice** falls back to Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`).
- **Screen capture** falls back to `getDisplayMedia`.
- **Desktop features** are silently unavailable on mobile (no fallback, `hasFallback: false`).

Web API detection helpers check for `SpeechRecognition`, `speechSynthesis`, `mediaDevices`, `geolocation`, and `getDisplayMedia` before reporting capability.

## Gateway Connection

On mobile, the agent typically runs on a separate machine (desktop or server). The mobile app connects to it via the Gateway plugin:

1. **Discovery** (native only) — the app broadcasts a Bonjour/mDNS query for `_eliza-gw._tcp` services. On iOS, the `NSBonjourServices` and `NSLocalNetworkUsageDescription` keys in `Info.plist` authorize this. Results stream in via the `discovery` event as gateways are found, lost, or updated.
2. **Manual connection** — enter the gateway WebSocket URL directly (e.g., `wss://192.168.1.100:8080`).
3. **WebSocket** — once connected, all communication happens over a persistent WebSocket with JSON-RPC style request/response and event streaming. The connection supports token and password authentication, role negotiation, and automatic reconnection.

### Android Foreground Service

On Android, the `GatewayConnectionService` keeps the process alive while the app is in the background. This is a foreground service with type `dataSync` that displays a persistent notification showing the gateway connection status.

Key behaviors:
- **Starts automatically** when `MainActivity.onCreate()` runs.
- **Stops** when the user swipe-kills the app (`isFinishing()` check in `onDestroy`).
- **Notification states:** "Starting...", "Connected" (WebSocket active), "Reconnecting" (attempting restore), "Disconnected".
- **User action:** The notification includes a "Disconnect" button that sends `ACTION_STOP` to the service.
- Uses `START_STICKY` so Android restarts the service if the system kills it.
- On Android 13+ (API 33), the app requests `POST_NOTIFICATIONS` permission at runtime for the notification to be visible.
- On Android 14+ (API 34), the service specifies `FOREGROUND_SERVICE_TYPE_DATA_SYNC` when calling `startForeground()`.

## Storage Bridge

The storage bridge ensures persistent data survives across app sessions on native platforms.

### How It Works

- **Web:** Pass-through to `localStorage` — no special handling needed.
- **Native (iOS/Android):** Intercepts `localStorage` operations via a proxy on `setItem`, `getItem`, and `removeItem`. Syncs specific keys to Capacitor's `Preferences` plugin for reliable persistence. An in-memory cache (`preferencesCache`) is loaded from Preferences at initialization to avoid async reads during synchronous `getItem` calls.

### Initialization

On native platforms, `initializeStorageBridge()` must be called before the app starts reading storage. It loads all synced keys from Capacitor Preferences into the cache and writes them to `localStorage` for immediate availability, then installs the `localStorage` proxy.

### Synced Keys

The following keys are automatically synced to native Preferences:

| Key | Purpose |
|-----|---------|
| `eliza.control.settings.v1` | Dashboard settings and preferences |
| `eliza.device.identity` | Device identity token |
| `eliza.device.auth` | Device authentication credentials |

### API

```typescript
// Read a value (works on both native and web)
const value = await getStorageValue("eliza.device.identity");

// Write a value
await setStorageValue("eliza.control.settings.v1", jsonString);

// Remove a value
await removeStorageValue("eliza.device.auth");

// Register additional keys for native sync
registerSyncedKey("my.custom.key");

// Check if initialization is complete
isStorageBridgeInitialized(); // boolean
```

## Capacitor Bridge

The global bridge object is exposed on `window.Eliza` and provides a unified API for all native capabilities.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `capabilities` | `CapacitorCapabilities` | Platform capability flags (native, haptics, camera, microphone, screenCapture, fileSystem, notifications, geolocation, background, voiceWake) |
| `pluginCapabilities` | `PluginCapabilities` | Per-plugin capability details (see above) |
| `haptics` | object | Haptic feedback functions: `light()`, `medium()`, `heavy()`, `success()`, `warning()`, `error()`, `selectionStart()`, `selectionChanged()`, `selectionEnd()` |
| `plugins` | `ElizaPlugins` | Access to all Eliza plugins with fallback support |
| `isFeatureAvailable(feature)` | function | Check if a specific feature is available on the current platform |
| `platform` | object | Platform detection: `name`, `isNative`, `isIOS`, `isAndroid`, `isDesktop`, `isWeb`, `isMacOS` |
| `getPlugin(name)` | function | Get a registered plugin by name |
| `hasPlugin(name)` | function | Check if a plugin is registered |
| `registerPlugin(name, plugin)` | function | Register a custom plugin at runtime |

### Initialization

The bridge dispatches a `eliza:bridge-ready` custom event on `document` when initialization completes. Use `waitForBridge()` to await initialization:

```typescript
import { waitForBridge } from "./bridge/capacitor-bridge";

const bridge = await waitForBridge();
console.log(bridge.platform.isIOS); // true on iPhone/iPad
```

If `window.Eliza` is already set, `waitForBridge()` resolves immediately. Otherwise it listens for the custom event.

## iOS-Specific Details

### Info.plist Permissions

The iOS app declares the following usage descriptions in `Info.plist`:

| Key | Description shown to user |
|-----|--------------------------|
| `NSCameraUsageDescription` | "Eliza uses your camera to capture photos and video when you ask it to." |
| `NSMicrophoneUsageDescription` | "Eliza needs microphone access for voice wake, talk mode, and video capture." |
| `NSLocationWhenInUseUsageDescription` | "Eliza uses your location to provide location-aware responses when you allow it." |
| `NSLocationAlwaysAndWhenInUseUsageDescription` | "Eliza can share your location in the background so it stays up to date even when the app is not in use." |
| `NSSpeechRecognitionUsageDescription` | "Eliza uses on-device speech recognition to listen for voice commands and wake words." |
| `NSPhotoLibraryUsageDescription` | "Eliza accesses your photo library to attach and share photos or videos." |
| `NSPhotoLibraryAddUsageDescription` | "Eliza saves captured photos and videos to your photo library." |
| `NSLocalNetworkUsageDescription` | "Eliza discovers and connects to your Eliza gateway on the local network." |
| `NSBonjourServices` | `_eliza-gw._tcp` (for gateway discovery) |

### Orientation Support

- **iPhone:** Portrait, landscape left, landscape right.
- **iPad:** All four orientations (portrait, portrait upside down, landscape left, landscape right).

### AppDelegate

The iOS `AppDelegate.swift` handles URL opens and Universal Links via `ApplicationDelegateProxy.shared`, which allows the Capacitor App plugin to track deep link opens.

## Android-Specific Details

### Permissions

The Android manifest declares these permissions:

| Permission | Purpose |
|------------|---------|
| `INTERNET` | Network access for gateway WebSocket and API calls |
| `RECORD_AUDIO` | Microphone for voice wake and talk mode |
| `CAMERA` | Photo and video capture |
| `ACCESS_FINE_LOCATION` | GPS-based location |
| `ACCESS_COARSE_LOCATION` | Network-based location |
| `ACCESS_BACKGROUND_LOCATION` | Location updates while app is backgrounded |
| `FOREGROUND_SERVICE` | Gateway connection foreground service |
| `FOREGROUND_SERVICE_DATA_SYNC` | Typed foreground service (API 34+) |
| `POST_NOTIFICATIONS` | Notification display (API 33+ runtime permission) |
| `WRITE_EXTERNAL_STORAGE` | File access (API 28 and below only) |
| `READ_EXTERNAL_STORAGE` | File access (API 32 and below only) |
| `WAKE_LOCK` | Keep CPU awake during background operations |

### Build Configuration

| Property | Value |
|----------|-------|
| `minSdkVersion` | 26 (Android 8.0) |
| `compileSdkVersion` | 35 |
| `targetSdkVersion` | 35 |
| `applicationId` | `com.elizaai.eliza` |
| `namespace` | `ai.eliza.app` |

### Activity Configuration

The main activity uses `singleTask` launch mode, which ensures only one instance exists. It handles orientation changes, keyboard events, screen size changes, and locale changes without recreating the activity.

## Development Workflow

### Live Reload (iOS)

For rapid development with live reload (all commands from the repo root):

```bash
# Build plugins and web assets
bun run build:ios

# Start Vite dev server in a separate terminal
bun run dev

# Open Xcode and run on a simulator
bun run cap:open:ios
```

Update the Capacitor server config to point to your dev server IP for live reload.

### Live Reload (Android)

```bash
# Build plugins and web assets
bun run build:android

# Start Vite dev server in a separate terminal
bun run dev

# Open Android Studio and run on an emulator
bun run cap:open:android
```

### Running Tests

```bash
# Unit tests (Vitest)
bun run test

# Watch mode
bun run test:watch
```

## Troubleshooting

### iOS: "No signing certificate" error

Open the Xcode project, select the App target, go to Signing & Capabilities, and select your development team. For simulator-only testing, automatic signing with a personal team is sufficient.

### Android: Gradle sync failed

1. Ensure Android SDK API 35 is installed via SDK Manager.
2. Verify `ANDROID_HOME` or `ANDROID_SDK_ROOT` environment variable is set.
3. Try `cd android && ./gradlew clean` and then rebuild.

### Web assets not updating on device

Run the build command from the repo root, which includes the sync step automatically:

```bash
bun run build:ios   # or build:android
```

### Gateway discovery not finding devices

- **iOS:** Ensure the app has local network permission (Settings -> Privacy -> Local Network).
- **Android:** Ensure the device is on the same Wi-Fi network as the gateway. Background network restrictions on some Android manufacturers may interfere.
- Both platforms require the gateway to be advertising via mDNS/Bonjour with the `_eliza-gw._tcp` service type.

### Foreground service notification not visible (Android)

On Android 13+, the `POST_NOTIFICATIONS` permission must be granted. The app requests this on first launch, but if denied, the foreground service notification is silently suppressed. Go to Settings -> Apps -> Eliza -> Notifications and enable notifications.

### Haptics not working

Haptic feedback is only available on physical iOS and Android devices. Simulators and emulators do not produce haptic output. On web, haptic calls are silently ignored.
