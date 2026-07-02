# Issue #11353 — real WKWebView gesture driver (XCUITest) evidence

Two capture legs:

1. **Authoring leg (Linux, 2026-07-02):** suite + probes written and DOM-e2e
   validated (`test:home-screen-e2e`, `test:chat-sheet-e2e`); no `xcodebuild`
   available there, so the iOS run was deferred to a Mac.
2. **Verification leg (macOS M4 Max + Xcode, iPhone 16 / iOS 18.1 simulator,
   2026-07-02):** the suite was run against the real WKWebView engine,
   diagnosed, hardened, and brought to green. Everything below is from this
   leg.

## What ships

- `packages/app-core/platforms/ios/App/AppUITests/GestureSemanticsUITests.swift`
  — real XCUITest touch driving WKWebView, asserting **semantic outcomes**
  through sr-only accessibility probes (`chat-detent:<pill|collapsed|half|full>`
  in ContinuousChatOverlay, `home-launcher-page:<home|launcher>` in
  HomeLauncherSurface). A renderer that is interactive but missing a probe is
  a HARD failure, never a silent skip.
- `packages/app/scripts/ios-device-capture.mjs` — default `-only-testing` is
  now the whole `AppUITests` target (boot + gestures); new
  `--agent-ready-timeout <sec>` / `ELIZA_AGENT_READY_TIMEOUT_SECONDS` knob
  (default 240, `0` = don't wait) bounds how long the gesture tests wait for
  the local model before sending chat turns.

## Test design (verified against the real engine)

| Test | Coverage | Sim result (iPhone 16, iOS 18.1) |
| --- | --- | --- |
| `testChatSheetDetentFlickCycle` | slow-drag free-settle open → flick to FULL → flick down to half → flick down to collapsed → thread-gated flick-up (reveal at half with a thread / REFUSED on an empty thread — both real, spec'd semantics) | **PASS** |
| `testLauncherPagerFiftyPercentSwipeThreshold` | slow sub-threshold drag snaps back; slow past-50% drag commits home→launcher (distance rule, velocity killed); edge-swipe-right returns home | **PASS** |
| `testMessageEditAffordanceRevealsViaTouch` | tap bubble → action row reveals Edit → inline editor opens prefilled | SKIP on this sim — user turn evicted during model warm-up (#11670) |
| `testLongPressSystemCalloutSuppression` | long-press on selectable text raises the system callout (positive control), long-press on the select-none home surface must not | SKIP on this sim — same eviction gates the positive-control bubble (#11670) |

The two skips are **named, evidence-backed preconditions**, not vacuous
greens: this simulator cannot reach local-model chat-readiness (see the bug
trail below), so turns sent during warm-up are evicted and the
message-dependent gestures have nothing to touch. They run fully on a
model-ready boot (physical device).

## How the flick failure was diagnosed (and why the suite is trustworthy)

The first sim runs failed `testChatSheetDetentFlickCycle`: a flick-up on the
collapsed sheet did nothing. A temporary document-level pointer-event recorder
was injected into the staged `index.html` (mirroring `pointerdown/move/up/
cancel` + `touchstart/…` into an AX-visible probe) and a matrix of injection
styles was replayed. Result: XCUITest's synthesized touches were delivered
**perfectly** (pd→pm×8→pu on `chat-sheet-grabber`, zero cancels) — the web
gesture engine received the flick and *deliberately refused it*, because
`onPullUp` from a collapsed sheet is thread-gated
(`if (!hasRevealableThread) return settleDrag()`) and the thread had been
emptied by the warm-up eviction. The touch pipeline itself
(`XCUICoordinate.press(forDuration:thenDragTo:withVelocity:)` at 2000 pt/s,
slow drags with hold-before-release, taps) round-trips into WKWebView
correctly. The suite was then restructured to assert the real semantics on
both sides of the gate.

## Real bugs found by this suite

- **#11669** — `local-inference/registry.json` stores absolute app-container
  paths; iOS rotates the container UUID on reinstall/update, so the model
  never loads again despite 6.5 GB of verified bundle on disk (the permanent
  "Loading Eliza-1 2B…"). Rewriting the UUID un-wedged the load with no other
  change.
- **#11670** — a user message sent during model warm-up renders optimistically
  and is then silently evicted by the post-turn history reload, contradicting
  the send-path's "server holds the turn through the warming window" promise.

## Repro (macOS + Xcode)

```bash
# 1. Stage the web bundle + iOS project (bakes the sr-only probes into the app):
bun run --cwd packages/app build:ios:local:sim

# 2. Boot a simulator, then run the whole AppUITests target (boot + gestures):
cd packages/app
node scripts/ios-device-capture.mjs --platform sim \
  --output ios/build/boot-capture/gesture-evidence

# Gesture suite only:
node scripts/ios-device-capture.mjs --platform sim \
  --only-testing AppUITests/GestureSemanticsUITests \
  --output ios/build/boot-capture/gesture-evidence

# On a lane that cannot reach local-model readiness (see #11669/#11670),
# skip the ready-wait explicitly:
node scripts/ios-device-capture.mjs --platform sim --agent-ready-timeout 0 …
```

Per-step screenshots, the AX hierarchy snapshot, and `test-summary.json` are
exported from the `.xcresult` into `<output>/attachments/` automatically; the
curated copies for this issue live next to this README (`sim-run/`).
`sim-run/gesture-suite-recording.mp4` is a real-time frame capture
(`simctl io screenshot` loop at ~2 fps, assembled with ffmpeg) of a full green
detent + pager run — XCTest only auto-attaches native screen recordings for
FAILED tests, and `simctl io recordVideo` was held by an orphaned host
recording session on this machine.

## Residual

- **Physical-device leg** (issue #11353's dependency note / #10722 row):
  MoonCycles-class devices load the local model, so the two eviction-gated
  tests run their full paths there. Sim coverage of those two unlocks when
  #11670 is fixed.
- Two-finger pinch: no pinch-bound semantic exists in the current app surface
  to assert; revisit when one ships.
