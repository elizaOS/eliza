# iOS Computer-Use — Honest Scope

Apple does not let third-party apps drive other apps. There is no equivalent
to Android's `MediaProjection` for full-screen capture without a user prompt,
no `ScreenCaptureKit` (that is macOS only), and no system-wide accessibility
API that a sandboxed iOS app can use to inject events into other apps.

This document spells out what *is* possible on iOS, exactly how each surface
behaves, and the manual validation checklist that has to be run on a real
device before any of this ships.

## What works

### 1. ReplayKit foreground capture (own app)

`RPScreenRecorder.shared().startCapture(handler:completionHandler:)` returns
`CMSampleBuffer`s of *the host app's* window. Useful for "show me what's on
the Milady screen right now."

```swift
RPScreenRecorder.shared().startCapture(handler: { sampleBuffer, type, error in
    // Receive frames for own-app capture only.
}, completionHandler: { error in
    // Setup result; ReplayKit shows a system permission prompt on first use.
})
```

Constraints:

- Frame delivery rate is the display refresh rate; the bridge throttles to a
  caller-supplied `frameRate` (default 1Hz).
- Hard cap of 30 seconds per session. Past that, the work has to move to a
  `BGProcessingTask`.

### 2. ReplayKit broadcast extension (system-wide capture)

A separate target with a ~50MB memory ceiling. Streams frames over an App
Group shared container into the main app. The user must start the broadcast
themselves via the system share-sheet picker — apps cannot programmatically
launch the extension.

```swift
override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer,
                                  with sampleBufferType: RPSampleBufferType) {
    // Compress + dump into the App Group container.
}
```

**iOS 26 / 26.1 beta regression**: extensions are killed within ~3 seconds
even when memory headroom is fine. We surface this as
`extension_died` from `broadcastExtensionHandshake` so callers can fall back
to foreground capture. Track Apple's feedback status before shipping this
target on iOS 26.

### 3. Apple Vision OCR

`VNRecognizeTextRequest` is on-device, free, supports ~30 languages, and
typically runs sub-300ms on modern devices.

```swift
let request = VNRecognizeTextRequest { request, error in
    let observations = request.results as? [VNRecognizedTextObservation]
    // Top candidate per observation; each has bounding box, text, confidence.
}
request.recognitionLevel = .accurate
request.recognitionLanguages = ["en-US"]
try VNImageRequestHandler(cgImage: cg).perform([request])
```

This is the OCR provider the WS6 scene-builder will pick up on iOS. The
provider interface is in
`eliza/plugins/plugin-computeruse/src/mobile/ocr-provider.ts`.

### 4. App Intents

The only sanctioned way to drive other apps. Each target app must expose
intents (Shortcuts-style). We support invocation via x-callback URL schemes
for the system apps in the static registry
(`ios-app-intent-registry.ts`):

- Mail — `mailto:` with `subject` / `body` / `cc` / `bcc`
- Messages — `sms:` with `body`
- Maps — `http://maps.apple.com/?daddr=...&dirflg=...`
- Safari — open URL

For richer intents (Notes append, Reminders add, Music play with a query)
the user has to donate the action via Shortcuts; we can then invoke via
`AppIntent` on iOS 16+. The bridge's `appIntentList` returns the runtime
list of donated intents this app sees.

### 5. UIAccessibility (own-app reading only)

`accessibilitySnapshot` walks the key window's view hierarchy and returns
`accessibilityLabel` / `accessibilityValue` / role. iOS gives us no way to
read another app's UIAccessibility tree.

### 6. Apple Foundation Models (iOS 26+)

Apple ships an on-device LLM under the `FoundationModels` framework when
Apple Intelligence is enabled. We expose this as an *opportunistic*
fast-path. If unavailable, the existing llama-cpp-capacitor (Qwen3-VL-2B)
local-inference path stays as the default.

Entitlement and Info.plist updates are listed below.

## What does NOT work

Stock iOS does not allow any of the following from a third-party app, and
we do not pretend otherwise:

- **Driving other apps' UI**. No cross-app input synthesis, no
  `MediaProjection` / `ScreenCaptureKit` equivalent, no system-wide
  accessibility event injection.
- **Listing other running apps' processes**. The kernel hides this from
  third-party apps; there is no `ps`-equivalent.
- **Persistent background inference past ~30s**, except via
  `BGProcessingTask` (opportunistic, OS-scheduled, not guaranteed).

If a feature spec calls for any of the above, escalate it as not feasible
on iOS rather than inventing a workaround that will get the app rejected
or silently broken by Apple in the next OS update.

## Entitlements + Info.plist

Add the following to `apps/app/ios/App/App/App.entitlements`:

```xml
<key>com.apple.developer.kernel.increased-memory-limit</key>
<true/>
<key>com.apple.developer.kernel.extended-virtual-addressing</key>
<true/>
```

Add the following to `apps/app/ios/App/App/Info.plist`:

```xml
<key>NSScreenCaptureDescription</key>
<string>Captures the Milady app window when you ask it to see the screen.</string>
<key>NSAppleEventsUsageDescription</key>
<string>Sends Shortcuts to other apps when you authorize an action.</string>
```

The screen capture string is shown on ReplayKit's first-launch system
prompt. The Apple Events string is shown only if the host (this app) ever
needs to drive AppleScript via the Catalyst surface; iOS apps that only
use `UIApplication.shared.open(url:)` to invoke x-callback intents do not
need it, but it costs nothing to include for forward compatibility with
Mac Catalyst builds.

## Validation checklist

The Swift code in this repo is unverified locally because there is no iOS
device available. Every file is marked
`// TODO: validate on device — checklist in IOS_CONSTRAINTS.md`. Before
shipping any of this:

### Simulator vs device

| Surface                          | Simulator | Real device |
| -------------------------------- | --------- | ----------- |
| ReplayKit foreground capture     | Partial   | Required    |
| Broadcast extension              | No        | Required    |
| Vision OCR                       | Yes       | Required    |
| App Intents (x-callback)         | Partial   | Required    |
| Accessibility snapshot           | Yes       | Required    |
| Foundation Models                | No        | Required    |
| Memory pressure probe            | Limited   | Required    |

### Per-method checklist

For each method below, run on at least one A14-or-later iPhone running the
target iOS (currently iOS 26.1, with iOS 17.6 as the floor):

1. **`probe()`** — assert `data.platform === "ios"`, `osVersion` matches the
   device, all six capability bits are present.
2. **`replayKitForegroundStart`** — assert the system permission prompt is
   shown on first use; on accept, `replayKitForegroundDrain` returns frames
   with non-empty `jpegBase64` and the device's screen resolution.
3. **`broadcastExtensionHandshake`** — bundle the extension target via Xcode,
   tap the share-sheet broadcast picker, and assert `broadcastActive`
   transitions to `true`. On iOS 26 betas, verify `regression.observed`
   eventually flips to `true` after the extension dies.
4. **`visionOcr`** — render a known PNG with the string `"WS9 OCR SMOKE"`
   into the app, run OCR with `recognitionLevel: "accurate"`, and assert
   `fullText` contains the source string (case-insensitive).
5. **`appIntentList`** — verify the returned list is empty for a fresh
   install and grows after the user donates intents via Shortcuts.
6. **`appIntentInvoke`** with `com.apple.mobilesafari.open-url` — assert
   Safari opens to the provided URL. With `com.apple.MobileSMS.send-message`
   — assert Messages opens with the recipient and body pre-filled.
7. **`accessibilitySnapshot`** — assert the returned tree's top-level node
   has `role !== "labeled"` and `children.length > 0` on a populated screen.
8. **`foundationModelGenerate`** — on a device with Apple Intelligence
   enabled, assert a short prompt returns non-empty text. With AI disabled,
   assert the call resolves with `foundation_model_unavailable`.
9. **`memoryPressureProbe`** — invoke `UIApplication.shared.performMemoryWarning()`
   (debug-only) and assert the next probe call returns
   `severity >= 0.7` with `lastWarningAt` set.

## Hand-off to other workstreams

- **WS1 (memory-pressure arbiter)** consumes `MemoryPressureSample` via the
  shared `IPressureSignal` contract in `ios-bridge.ts`. The bridge is the
  producer; the arbiter is the consumer. WS1 will subscribe to push events
  via the bridge once that channel lands; for now it polls `memoryPressureProbe`.
- **WS6 (scene-builder OCR)** picks up the iOS Vision provider through
  `selectOcrProvider()` in `ocr-provider.ts`. Register the provider at app
  boot when running on iOS:
  ```ts
  registerOcrProvider(
    createIosVisionOcrProvider(() => Capacitor.Plugins.ComputerUse),
  );
  ```

## Apple documentation references

- ReplayKit — https://developer.apple.com/documentation/replaykit
- Vision Text Recognition — https://developer.apple.com/documentation/vision/recognizing_text_in_images
- App Intents — https://developer.apple.com/documentation/appintents
- Foundation Models — https://developer.apple.com/documentation/foundationmodels (iOS 26)
- App Groups — https://developer.apple.com/documentation/xcode/configuring-app-groups
- `os_proc_available_memory()` — https://developer.apple.com/documentation/foundation/process_info/3743117-os_proc_available_memory
- Background Tasks — https://developer.apple.com/documentation/backgroundtasks
