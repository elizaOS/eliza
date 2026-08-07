# @elizaos/capacitor-camera

Capacitor plugin that gives Eliza agents camera preview, photo capture, and video recording across web, iOS, and Android.

## Purpose / role

This package is a [Capacitor](https://capacitorjs.com/) plugin, not a standard elizaOS runtime plugin. It exposes a unified `Camera` object backed by platform-native implementations (Swift on iOS, Kotlin on Android) and a `CameraWeb` fallback that uses the browser's `MediaDevices` API. It is loaded by registering it with `@capacitor/core` under the plugin name `"ElizaCamera"`. It does not export an elizaOS `Plugin` object and is not auto-enabled by the elizaOS runtime — consuming apps must wire it up via Capacitor's plugin registry.

## Plugin surface

This is a Capacitor plugin, not an elizaOS action/provider/evaluator plugin. The exported API surface is:

| Export | File | Description |
|---|---|---|
| `Camera` | `src/index.ts` | Capacitor plugin instance (registered as `"ElizaCamera"`) |
| `CameraWeb` | `src/web.ts` | Web fallback implementation (`WebPlugin` subclass) |
| All types | `src/definitions.ts` | TypeScript interfaces and types for the full plugin API |

### `CameraPlugin` interface methods (from `src/definitions.ts`)

| Method | Description |
|---|---|
| `getDevices()` | List available camera devices with capabilities |
| `startPreview(options)` | Start live preview into a DOM element |
| `stopPreview()` | Stop preview and release camera resources |
| `switchCamera(options)` | Switch to a different camera device or direction |
| `capturePhoto(options?)` | Capture a still photo as base64 from the active preview |
| `startRecording(options?)` | Start video recording (with optional audio, bitrate, duration/size limits) |
| `stopRecording()` | Stop recording and return a `VideoResult` with blob URL and metadata |
| `getRecordingState()` | Poll current recording duration and file size |
| `getSettings()` | Read current camera settings (flash, zoom, focus, exposure, white balance) |
| `setSettings(options)` | Apply partial `CameraSettings` update |
| `setZoom(options)` | Set zoom level (1.0 = no zoom; clamped to device max) |
| `setFocusPoint(options)` | Set manual focus point (x, y normalized 0–1) |
| `setExposurePoint(options)` | Set manual exposure point (x, y normalized 0–1) |
| `checkPermissions()` | Read current permission state without prompting |
| `requestPermissions()` | Trigger OS permission dialogs for camera + microphone |

### Events (via `addListener`)

| Event name | Payload type | Fired when |
|---|---|---|
| `"frame"` | `CameraFrameEvent` | Each video frame (timestamp, width, height) |
| `"error"` | `CameraErrorEvent` | Recording or stream error (code + message) |
| `"recordingState"` | `VideoRecordingState` | Recording started, periodic update, or stopped |

## Layout

```
plugins/plugin-native-camera/
  src/
    index.ts          — Registers the Capacitor plugin; exports `Camera` and all types
    definitions.ts    — All TypeScript interfaces (CameraPlugin, CameraDevice, PhotoResult, VideoResult, CameraSettings, ...)
    web.ts            — CameraWeb: MediaDevices API implementation for browser runtime
    web.test.ts       — Vitest unit tests for the CameraWeb implementation
  ios/
    Sources/CameraPlugin/
      CameraPlugin.swift   — AVFoundation-based native iOS implementation
  android/
    src/main/java/ai/eliza/plugins/camera/
      CameraPlugin.kt      — Camera2 API-based native Android implementation
    src/main/AndroidManifest.xml
  ElizaosCapacitorCamera.podspec  — CocoaPods spec for iOS distribution
  rollup.config.mjs               — Bundles dist/plugin.js (IIFE) and dist/plugin.cjs.js
  vitest.config.ts                — Vitest configuration for unit tests
  tsconfig.json
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-camera clean           # remove build output
bun run --cwd plugins/plugin-native-camera build           # build package artifacts
bun run --cwd plugins/plugin-native-camera typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-camera lint            # mutating Biome check
bun run --cwd plugins/plugin-native-camera lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-camera format          # write formatting
bun run --cwd plugins/plugin-native-camera format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-camera test            # run package tests
bun run --cwd plugins/plugin-native-camera prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-camera watch           # watch TypeScript sources
bun run --cwd plugins/plugin-native-camera build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
```

## Config / env vars

This plugin reads no environment variables and has no elizaOS config keys. Camera and microphone permission state is managed by the OS; call `checkPermissions()` / `requestPermissions()` at runtime.

Capacitor plugin registration name: `"ElizaCamera"` (used internally by `@capacitor/core`).

## How to extend

### Add a new method to the plugin API

1. Declare the method signature in `src/definitions.ts` on the `CameraPlugin` interface.
2. Implement it in `src/web.ts` on `CameraWeb` (browser path).
3. Implement it in `ios/Sources/CameraPlugin/CameraPlugin.swift` (iOS).
4. Implement it in `android/src/main/java/ai/eliza/plugins/camera/CameraPlugin.kt` (Android).
5. Re-export any new types from `src/index.ts` if needed (it re-exports everything from `definitions.ts`).

### Add a new event

1. Add an `addListener` overload to `CameraPlugin` in `src/definitions.ts` with the new event name and payload type.
2. Call `this.notifyListeners("eventName", payload)` in `CameraWeb` (web) and the equivalent Capacitor bridge call in the native implementations.

## Conventions / gotchas

- **Not an elizaOS runtime plugin.** There is no `Plugin` object with actions/providers/services. Capacitor plugins are loaded by the Capacitor runtime, not the elizaOS plugin loader.
- **Web permission flow.** `startPreview()` calls `getUserMedia()` directly, which triggers the browser/OS dialog implicitly. Native permission probing is handled outside this Capacitor web fallback.
- **Web flash/torch.** The `MediaDevices` API does not expose torch control on web. `hasFlash` is inferred from `MediaTrackCapabilities.torch`; it will always be `false` on most desktop browsers.
- **Video mime type selection.** `CameraWeb` tries `video/webm;codecs=vp9,opus` → `vp8,opus` → `video/webm` → `video/mp4` in order. `stopRecording()` returns a `blob:` URL, not a file path.
- **Manual focus/exposure on web.** `setFocusPoint` and `setExposurePoint` throw if the device does not report `"manual"` in its `focusMode`/`exposureMode` capabilities — which is the case for most desktop webcams.
- **Build output.** `tsc` compiles to `dist/esm/`; rollup then bundles into `dist/plugin.js` (IIFE for browser script tag) and `dist/plugin.cjs.js` (CJS). The `exports` field in `package.json` points bun/dev builds directly at `src/index.ts`.
- **iOS deployment target:** iOS 15.0+, Swift 5.9. Depends on `AVFoundation`, `Photos`, and `UIKit`.
- **Android:** Kotlin implementation under `ai.eliza.plugins.camera`. Camera enumeration is read via `CameraDeviceReader` and covered by an **instrumented test** (`android/src/androidTest/.../CameraDeviceReaderInstrumentedTest.kt`) run on a real device/emulator via `./gradlew :elizaos-capacitor-camera:connectedDebugAndroidTest` from `packages/app-core/platforms/android` (issue #9967); `getDevices` delegates to the reader (JS shape unchanged).
- See root `CLAUDE.md` for repo-wide conventions (logger, ESM, naming, architecture rules).

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
