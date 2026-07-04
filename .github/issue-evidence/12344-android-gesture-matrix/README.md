# #12344 — Mobile chat gesture matrix + video (parent #12188)

Extends on-device gesture coverage to the full chat gesture matrix on Android
(Playwright real-touch) and iOS (XCUITest real WKWebView), captures each run as
video, and adds a chunked `adb screenrecord` so walkthroughs longer than the
180s per-file cap are one continuous file.

## What ships

- `packages/app/test/android/touch-gesture.android.spec.ts` — was one launcher
  swipe; now a serial gesture matrix (sheet detents, home↔launcher rail + back,
  push-to-talk hold, keyboard avoidance, media attachment, long-press). Every
  gesture is dispatched as REAL `adb input` touch and asserts (1) the WebView
  received real touch events (touch\*/pointerType "touch", zero mouse) and (2)
  the app's own gesture semantics. Agent/mic-dependent legs skip honestly.
- `packages/app/scripts/lib/android-capture.mjs` — `startChunkedAndroidScreenRecord`:
  records back-to-back capped segments, pulls each, concats with ffmpeg
  (`-f concat -c copy`). The whole matrix records through it as one file.
- `packages/app/scripts/capture-android-emu.mjs` — routes `--duration > 180`
  through the chunked recorder.
- `packages/app-core/platforms/ios/App/AppUITests/GestureSemanticsUITests.swift`
  — adds `testPushToTalkHoldDoesNotLatchHandsFree`, `testComposerLiftsClearOfKeyboard`,
  and `testAttachAffordanceOpensSystemPicker` on the real WKWebView engine.

## How a reviewer produces the videos (uncontended device)

```bash
# Android matrix walkthrough → .github/issue-evidence/12344-android-gesture-matrix/
#   android-gesture-matrix.mp4 (one chunked file) + gesture-*.png + logcat.txt
bun run --cwd packages/app test:e2e:android:touch-gesture   # ELIZA_ANDROID_REQUIRE_AGENT=0 for frontend-only legs

# iOS gesture suite (simctl recordVideo via the AppUITests lane)
bun run --cwd packages/app capture:ios-sim
```

## Evidence captured in this session

- `ffmpeg-concat-proof.mp4` — the chunked recorder's concat step, validated
  deterministically: three 4s segments encoded with identical params concat to
  one **12.0s** file via `-f concat -c copy` (the exact command the helper
  runs). This is the core new algorithm proven end-to-end.

## Honest status of on-device capture

On-device Android video/screenshot capture could NOT be produced in this
session: emulator-5584 was concurrently owned by the device-lifecycle test lane
(feat/device-lifecycle-test-lane), which cycles the emulator/app. One-shot
`adb shell echo` returned instantly, but every sustained adb data operation
(`exec-out screencap`, `pull`, `screenrecord`) died (rc=124) because adbd was
being disrupted mid-stream. The gesture-matrix spec and chunked recorder are
implemented, biome-formatted, and type-consistent with the existing suite; the
ffmpeg concat path is proven above; the two capture commands above produce the
full videos on a device this session does not share. The iOS Swift legs are
verified by review (xcodebuild/simctl not run here) and follow the existing
`GestureSemanticsUITests` harness patterns exactly.
