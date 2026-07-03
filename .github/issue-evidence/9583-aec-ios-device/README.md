# #11373 — iOS physical-device AEC leg (MoonCycles, iPhone 16 Pro Max, iOS 18.7.8)

Captured 2026-07-03 on Shaw's **physical iPhone 16 Pro Max** ("MoonCycles",
udid `00008140-0006491E2E90801C`), devicectl. This documents how far the
on-device iOS acoustic-loop leg got and the exact blocker that stops the
acoustic ERLE measurement.

## What is PROVEN on the real device

1. **Build → sign → install → boot, all fixes aboard.** The current tree
   (route-gate + AEC-diarizer decoupling + agent-side capture mirror) was built
   unsigned via `run-mobile-build ios-local`, profile-grafted + nested-signed
   (`codesign --verify --deep --strict` OK), and installed on MoonCycles via
   `devicectl`. `moon-boot-trace-key-stages.json` (pulled from the app's
   `Documents/eliza-boot-trace.jsonl`) shows the app process launching and the
   in-process **bun agent bootstrapping to ready** on the device:
   `engine-host-start` → `engine-bootstrap-ok` (2.1 s) → `engine-start-ok` →
   the first `ready:true` agent probe (14 s here on a warm PGlite; ~2.5 min on
   the first cold-DB install). `moon-boot-trace-full.jsonl` is the raw trace.
2. **The `libelizainference` fused voice lib is NOT shipped for iOS** — the app
   embeds only `ElizaBunEngine.framework`, whose binary exports no
   `eliza_inference_*` ABI. This is why `/api/voice/audio-frames` would `500`
   with "fused libelizainference not found" on iOS, and is exactly what the
   **AEC-diarizer decoupling** fix in this PR addresses: the pure-TS AEC seam
   (delay calibration + near/far capture) now runs without the native diarizer.
3. **The deep link is delivered to the app.** `moon-deeplink-delivered.txt` is
   the device console showing `UIOpenURLAction: elizaos://aec-loop?...` — iOS
   LaunchServices hands the harness trigger URL to the app. (Reaching this
   required a driver fix: `devicectl process launch <url>` mis-parses the URL as
   a bundle path; it must be passed via `--payload-url <url> <bundleid>`.)

## The blocker (honest): the harness never executes on cold launch

An agent-side "capture armed" probe confirmed it: after the deep link is
delivered AND the agent is ready, the harness's very first agent call
(`POST /api/voice/aec-capture {arm:true}`) **never lands** — `harness-armed=0,
full-capture=0` across repeated runs. So the URL reaches the app natively
(`UIOpenURLAction`) but the Capacitor **cold-launch** hand-off
(`appUrlOpen` → `handleDeepLink` → the `#aec-loop` hash the harness watches)
does not fire, so `window.__aecLoop` never runs. Nothing writes a result, an
error, or an arm marker.

Two independent things then gate an autonomous physical-device acoustic capture,
both **iOS OS-level human taps** I cannot perform headless:

- **Screen unlock** — launching/running an app needs the device unlocked.
- **Microphone permission** — the harness's `getUserMedia` raises the system
  "Allow microphone" prompt on first use; iOS has no CLI mic-grant (unlike
  Android's `pm grant`).

And triggering the harness reliably needs either a cold-launch deep-link
hand-off that fires (a Capacitor limitation here) or **Web Inspector / CDP**,
which requires a human to enable *Settings → Safari → Advanced → Web Inspector*
(and the RemoteXPC tunnel `ios_webkit_debug_proxy` could not attach). None of
these are clearable by an autonomous agent.

## Disposition

The AEC transport + route + decoupling fixes are proven on-device up to the
trigger, and the bridge-free retrieval (`GET /api/voice/aec-capture` →
`$ELIZA_STATE_DIR/eliza-aec-capture.json`) is unit-tested and lands correctly
whenever the harness runs (verified against the Android emulator app path).
The remaining **acoustic ERLE + double-talk + measured playback→mic delay on a
physical iPhone** need a human at the device to unlock it, tap Allow on the mic
prompt, and drive the harness (via voice mode or Web Inspector). Real acoustic
ERLE with the same production canceller is in `../9583-aec-macos/` (~68 ms,
full ERLE series). The Android app-path transport proof is in
`../9583-aec-android-emulator/`.

## Files

- `moon-boot-trace-key-stages.json` / `moon-boot-trace-full.jsonl` — on-device
  boot → agent-ready trace.
- `moon-deeplink-delivered.txt` — the `UIOpenURLAction` proof the harness URL
  reached the app.
