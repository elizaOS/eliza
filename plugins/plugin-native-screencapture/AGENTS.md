# @elizaos/capacitor-screencapture

Capacitor plugin providing cross-platform screenshot and screen-recording capabilities for Eliza agents running in browser, iOS, Android, and Node/Electrobun environments.

## Purpose / Role

This is a [Capacitor](https://capacitorjs.com/) plugin — not an elizaOS runtime plugin. It exposes a unified `ScreenCapture` JS API that routes to the correct native implementation at runtime: `ScreenCaptureWeb` for browsers (via `getDisplayMedia`), a Swift `ScreenCapturePlugin` for iOS (via ReplayKit + AVFoundation), and a Kotlin `ScreenCapturePlugin` for Android (via MediaProjection). In the elizaOS desktop shell (Electrobun/Node), the web implementation is used through the Node runtime path. It is opt-in: nothing registers it automatically. The elizaOS app or a downstream plugin must call `registerPlugin` by importing this package.

No elizaOS actions, providers, services, evaluators, or routes are defined here. This is a Capacitor primitive that higher-level elizaOS plugins depend on.

## Plugin Surface

This package exports one Capacitor plugin object:

| Export | Description |
|--------|-------------|
| `ScreenCapture` | Registered Capacitor plugin handle (use this to call all methods) |

All types are re-exported from `src/definitions.ts`:

| Interface | Purpose |
|-----------|---------|
| `ScreenCapturePlugin` | Full method contract (TypeScript interface) |
| `ScreenshotOptions` | Options for `captureScreenshot` (format, quality, scale, captureSystemUI) |
| `ScreenshotResult` | `{ base64, format, width, height, timestamp }` |
| `ScreenRecordingOptions` | Options for `startRecording` (quality, fps, bitrate, maxDuration, maxFileSize, captureAudio, captureSystemAudio, captureMicrophone, showTouches) |
| `ScreenRecordingState` | `{ isRecording, duration, fileSize, fps? }` |
| `ScreenRecordingResult` | `{ path, duration, width, height, fileSize, mimeType }` |
| `ScreenCapturePermissionStatus` | `{ screenCapture, microphone }` |
| `ScreenCaptureErrorEvent` | `{ code, message }` |

### Methods on `ScreenCapture`

| Method | Description |
|--------|-------------|
| `isSupported()` | Returns `{ supported, features[] }` — features vary by platform |
| `captureScreenshot(options?)` | Single frame capture; returns base64-encoded image |
| `startRecording(options?)` | Begin screen recording; resolves when recording starts |
| `stopRecording()` | Stop and finalize; returns `ScreenRecordingResult` with file path |
| `pauseRecording()` | Pause an active recording (Android requires API 24+) |
| `resumeRecording()` | Resume a paused recording |
| `getRecordingState()` | Poll current state without subscribing to events |
| `checkPermissions()` | Check screen-capture + microphone permission state |
| `requestPermissions()` | Request microphone permission (screen permission is always prompt-on-use) |

### Events (via `addListener`)

| Event | Payload | Description |
|-------|---------|-------------|
| `recordingState` | `ScreenRecordingState` | Emitted ~every 500 ms during recording and on state transitions |
| `error` | `ScreenCaptureErrorEvent` | Emitted on async recording errors |

## Layout

```
plugins/plugin-native-screencapture/
  src/
    definitions.ts       All TypeScript interfaces and the ScreenCapturePlugin contract
    index.ts             Entry point — calls registerPlugin("ScreenCapture", { web: loadWeb })
    web.ts               Browser implementation: getDisplayMedia, MediaRecorder, ImageCapture API
    web.test.ts          Vitest unit tests for the web implementation
  ios/
    Sources/ScreenCapturePlugin/
      ScreenCapturePlugin.swift   iOS impl: RPScreenRecorder + AVAssetWriter; thread-safe CaptureState
  android/
    src/main/java/ai/eliza/plugins/screencapture/
      ScreenCapturePlugin.kt      Android impl: MediaProjection + MediaRecorder; coroutine-based
    src/main/AndroidManifest.xml  FOREGROUND_SERVICE + RECORD_AUDIO + FOREGROUND_SERVICE_MEDIA_PROJECTION declarations
  ElizaosCapacitorScreencapture.podspec   CocoaPods spec (iOS 15.0+, Swift 5.9)
  rollup.config.mjs    Bundles dist/plugin.js (IIFE) and dist/plugin.cjs.js from compiled ESM
  tsconfig.json
  package.json
```

## Commands

All scripts come from `package.json`. Run from repo root with `--cwd`:

```bash
bun run --cwd plugins/plugin-native-screencapture build    # clean + tsc + rollup
bun run --cwd plugins/plugin-native-screencapture clean    # remove dist/
bun run --cwd plugins/plugin-native-screencapture watch    # tsc --watch (no rollup)
bun run --cwd plugins/plugin-native-screencapture test     # vitest run (src/web.test.ts)
```

## Config / Env Vars

This plugin reads no environment variables and has no configuration schema. All behavior is controlled at call time via method options.

Platform-specific requirements:
- **iOS:** `NSMicrophoneUsageDescription` must be present in the host app's `Info.plist` when `captureMicrophone: true`. ReplayKit screen recording requires no separate entitlement on iOS 11+.
- **Android:** `FOREGROUND_SERVICE`, `RECORD_AUDIO`, and `FOREGROUND_SERVICE_MEDIA_PROJECTION` (API 34+) are all declared in the plugin's `AndroidManifest.xml`. `RECORD_AUDIO` is also enforced at runtime via the `@CapacitorPlugin` `Permission` annotation — microphone permission is requested when `captureMicrophone: true`.
- **Browser:** `getDisplayMedia` always shows a system OS picker dialog — there is no way to pre-grant or skip it. Microphone can be pre-requested via `requestPermissions()`.

## How to Extend

**Add a new method to the plugin:**

1. Add the method signature to `ScreenCapturePlugin` in `src/definitions.ts`.
2. Implement it in `src/web.ts` in `ScreenCaptureWeb`.
3. Add the method to `pluginMethods` in `ios/Sources/ScreenCapturePlugin/ScreenCapturePlugin.swift` and implement the `@objc` handler.
4. Add a `@PluginMethod` in `android/src/main/java/ai/eliza/plugins/screencapture/ScreenCapturePlugin.kt`.
5. Build: `bun run --cwd plugins/plugin-native-screencapture build`.

**Add a new event:**

Emit from native via `self.notifyListeners("eventName", data: [...])` (Swift) or `notifyListeners("eventName", jsObject)` (Kotlin), then add a typed `addListener` overload in `definitions.ts`.

## Conventions / Gotchas

- **This is a Capacitor plugin, not an elizaOS runtime plugin.** It exports `ScreenCapture` (a Capacitor plugin handle), not a `Plugin` object from `@elizaos/core`. Do not confuse the two.
- **Web screenshot requires user gesture.** `captureScreenshot` calls `getDisplayMedia`, which must be triggered by a user interaction in a browser context. Calling it programmatically (e.g., from an agent action without a gesture) will fail or be blocked.
- **iOS screenshot does NOT use ReplayKit.** It renders `UIWindow` layers via `UIGraphicsImageRenderer`, so no screen-recording permission is required for screenshots — only for `startRecording`.
- **AVAssetWriter is initialized lazily** on the first video sample in the iOS implementation. This is intentional (gets exact pixel dimensions from the hardware, not from `UIScreen`). Writer init errors surface asynchronously via the `error` event.
- **Pause on Android requires API 24+.** `pauseRecording` and `resumeRecording` reject with an explicit error on older versions.
- **Web `stopRecording` returns a `blob:` URL**, not a filesystem path. The `path` field in `ScreenRecordingResult` will be a `blob:` URL on web; on native it is a filesystem path.
- **iOS output is `.mp4` (H.264 + AAC).** Web output is WebM (VP9/VP8) or MP4 depending on browser support — check `mimeType` in the result.
- **The npm name is `@elizaos/capacitor-screencapture`**, not `@elizaos/plugin-native-screencapture`. The directory name and the npm name differ.
- The `dist/` directory is gitignored and must be built before native/web integration is tested. Run `bun run --cwd plugins/plugin-native-screencapture build` first.
