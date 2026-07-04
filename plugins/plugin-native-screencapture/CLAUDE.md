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

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-screencapture clean           # remove build output
bun run --cwd plugins/plugin-native-screencapture build           # build package artifacts
bun run --cwd plugins/plugin-native-screencapture typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-screencapture lint            # mutating Biome check
bun run --cwd plugins/plugin-native-screencapture lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-screencapture format          # write formatting
bun run --cwd plugins/plugin-native-screencapture format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-screencapture test            # run package tests
bun run --cwd plugins/plugin-native-screencapture prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-screencapture watch           # watch TypeScript sources
bun run --cwd plugins/plugin-native-screencapture build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
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

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
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

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
