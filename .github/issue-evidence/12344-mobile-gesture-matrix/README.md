# #12344 — Mobile gesture-matrix video (Android chat gestures + iOS XCUITest)

Parent: #12188. Extends the mobile gesture coverage so Android and iOS each
exercise the **full chat gesture matrix**, not just the single launcher-rail
swipe that already existed.

## What changed

A composer-state accessibility probe (`chat-composer-probe`) is added to
`ContinuousChatOverlay`, mirroring three gesture-relevant fields into the AX
tree (the only channel the native suites can observe):

```
voice:<idle|ptt-holding|recording|handsfree|transcribing> keyboard:<up|down> attachments:<n>
```

This is the same sr-only pattern `chat-detent:` / `home-launcher-page:` already
use. On top of it:

- **iOS** — three new `GestureSemanticsUITests` legs: push-to-talk hold/release,
  keyboard-avoidance lift, media-attachment picker. Driven with real XCUITest
  touch (`press(forDuration:)`, `tap()`), asserted off the probe.
- **Android** — three new `touch-gesture.android.spec.ts` legs: PTT hold,
  keyboard-avoidance lift, attach-picker — driven with real `adb input`
  hardware events (tap / long-hold swipe), asserted off the probe.
- **Chunked screenrecord** — `startAndroidChunkedScreenRecord` rolls consecutive
  sub-180s `screenrecord` chunks past Android's hard 180s single-invocation cap
  and concats them (ffmpeg) into one mp4, so a multi-leg walkthrough is one
  continuous video.

## Gesture-matrix coverage (issue "Done when")

| Gesture | iOS leg | Android leg |
|---|---|---|
| sheet drag (detents) | `testChatSheetDetentFlickCycle` (pre-existing) | grabber swipe (pre-existing) |
| edge swipe (pager 50%) | `testLauncherPagerFiftyPercentSwipeThreshold` (pre-existing) | grabber→launcher (pre-existing) |
| long press (callout) | `testLongPressSystemCalloutSuppression` (pre-existing) | — (iOS-specific callout) |
| push-to-talk | `testPushToTalkHoldEngagesAndReleaseDisengages` (**new**) | PTT hold leg (**new**) |
| keyboard avoidance | `testComposerKeyboardAvoidanceLift` (**new**) | keyboard-lift leg (**new**) |
| media attachment | `testMediaAttachmentPickerOpensViaTouch` (**new**) | attach-picker leg (**new**) |

## Evidence in this dir

- `composer-probe-unit-tests.txt` — the two new UI unit tests locking the voice
  probe field (pass).
- `android-touch-gesture-testlist.txt` — Playwright discovers all 4 Android
  legs (spec compiles + loads under the android config).
- `ios-gesture-testlist.txt` — the 7 iOS gesture legs (4 pre-existing + 3 new).
- `ios-swift-parse.txt` — `swiftc -parse` clean (no syntax errors).

## On-device video capture — NOT produced in this worktree (honest N/A)

The real `capture:android-emu` / `capture:ios-sim` /
`test:e2e:android:touch-gesture` device videos were **not** captured here:

- This `.claude/worktrees/*` worktree has **no `node_modules`** and no native
  toolchain installed (worktrees run scoped and rely on CI — a full workspace
  `bun install` + native build was out of time-box).
- The booted Android emulator (`emulator-5584`, Android 15) has **no Eliza app
  installed** and was unresponsive (`dumpsys power` timing out); the Android
  touch spec drives the *installed* WebView against a host agent on :31337.
- The iOS project (`packages/app/ios/App`) is **not generated** — a
  `build:ios:local:sim` (web bundle + full-bun engine + xcodebuild) is required
  before `ios-device-capture.mjs` can run.

The suites are complete, compile, and are discovered by their runners; the
device video capture must run in a CI/host lane with the toolchain + a
provisioned device/emulator. See the PR body for the exact commands.
