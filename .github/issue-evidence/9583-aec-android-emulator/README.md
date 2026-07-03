# #11373 — Android on-device AEC transport evidence (emulator-5554)

Captured 2026-07-03 on an M4 Max, `adb` emulator `emulator-5554`
(AVD `Pixel_API_35`, Android 15), worktree `test/11373-aec-device-loops`.
This is the **honest supplement** leg of #11373, NOT a Pixel 6a substitute: it
exercises the **real Android app path** (the production `/api/voice/*`
transport, the live playback-reference producer, the AEC seam, and the native
`libelizainference.so` load — #11372), driven by the committed on-device
harness (`packages/ui/src/voice/aec-loop-harness.ts` → `window.__aecLoop`) over
CDP with `.github/issue-evidence/9583-aec-device-loops/driver/android-emulator-driver.mjs`.

## What is PROVEN here (real, on-device)

The harness ran the whole loop inside the app WebView against the in-process
bun agent. From `aec-loop-result-echo-only.json` (`statusAfter.aec`):

- **live playback-reference producer works** — `POST /api/voice/playback-frames`
  delivered **`playbackSamplesReceived: 417600`** (26 s @ 16 kHz),
  `playbackFramesReceived: 1305`, `lastPlaybackFrameAt` advancing,
  **`echoReferenceWired: true`** — the exact `#9583` acceptance signals.
- **1569 mic frames + 1552 playback frames** streamed through
  `/api/voice/audio-frames` and `/api/voice/playback-frames` in the device wire
  shape, and the bounded **`/api/voice/aec-capture`** snapshot was armed +
  pulled — all three routes reachable on-device.
- **native fused lib loads** — `logcat-native-inference.txt`:
  `libelizainference.so present; exporting ELIZA_INFERENCE_LIBRARY=…` then
  `enabling native bun:ffi inference (ELIZA_LOCAL_LLAMA=1)`.
- `android-app-running.png` — the booted app serving the loop.

These three signals only exist because of the fixes in the accompanying commit
(`fix(voice): unblock on-device AEC capture on mobile`): before them,
`/api/voice/playback-frames` + `/api/voice/aec-capture` **404'd** on every
mobile device (route gate), and `/api/voice/audio-frames` **500'd** with "fused
libelizainference not found" (unexported env). This leg is the on-device
verification of those fixes.

## What is NOT measurable here, and why (emulator I/O limitation)

Echo-only **ERLE is 0 dB** here (`android-emulator-echo-only-erle-report.json`)
because the emulator's **virtual microphone does not carry the host mic**, so
there is no real acoustic near-end to cancel. See `mic-characterization.json`:

| source | RMS | max | note |
|---|---|---|---|
| Mac built-in mic (direct `sox -d`) | 0.021 | 0.116 | clean room floor (≈ the accepted macOS loop) |
| emulator guest mic, Mac output muted | 0.67 | 1.0 | full-scale, near-DC zero-cross — synthetic, not the host mic |
| emulator guest mic during the loop | near 0.0003 | — | near-silent while the far-end reference delivered at RMS 0.093 |

The far-end reference is delivered correctly (`farRms 0.093`); the **near** is
the emulator's broken virtual mic (silent or saturated-synthetic). Headless
there is no way to enable "virtual mic uses host audio input" / grant the
emulator macOS microphone permission, so a real acoustic loop is not possible
on this emulator. This is an emulator audio-I/O limitation, **not** an app or
AEC defect.

**Real acoustic ERLE + measured playback→mic delay come from a physical device
(iOS, once unlocked) and the accepted macOS loop** (`../9583-aec-macos/`,
~68 ms, full ERLE series, synthetic-echo validity control).

## Files

- `aec-loop-result-echo-only.json` — raw device result (agent aec-capture
  near/far PCM + delivery counters + before/after status DTOs). Page-side PCM
  copies stripped to keep it small.
- `android-emulator-echo-only-erle-report.json` — offline replay through the
  production `EchoReferenceBuffer`/`NlmsEchoCanceller`/`computeErle`.
- `android-emulator-echo-only-{near-mic,far-reference}.wav` — the near (silent
  synthetic mic) and far (delivered reference) as captured — inspect to confirm.
- `logcat-native-inference.txt`, `mic-characterization.json`,
  `android-app-running.png`.

## Reproduce

```bash
adb -s emulator-5554 install -r -g packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 shell am start -n ai.elizaos.app/.MainActivity   # wait ~40s for the agent
node .github/issue-evidence/9583-aec-device-loops/driver/android-emulator-driver.mjs \
  --serial emulator-5554 --far-end-wav <farend-16k.wav> \
  --out .github/issue-evidence/9583-aec-android-emulator --skip-double-talk
bun .github/issue-evidence/9583-aec-device-loops/driver/measure-device-erle.ts \
  --input .github/issue-evidence/9583-aec-android-emulator/aec-loop-result-echo-only.json \
  --out .github/issue-evidence/9583-aec-android-emulator --label android-emulator-echo-only
```

(`--far-end-wav` supplies the agent's speech because the emulator ships no local
TTS bundle; the harness plays it through the device speaker as a `data:` URL so
the `https://localhost` WebView never trips mixed-content blocking. The subject
under test — transport + AEC + native lib — is unchanged.)
