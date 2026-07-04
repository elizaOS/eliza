# #11373 — Pixel 6a physical-device AEC acoustic-loop evidence (Android)

Captured 2026-07-03 on a **physical Pixel 6a** (bluejay, Android 16, serial
`27051JEGR10034`, USB) attached to a headless Linux x64 host, worktree
`evidence/11373-aec-android` (develop + the fixes in this branch). This is the
**Android target-device leg** of #11373 that the earlier legs could not reach:
the emulator's virtual mic is synthetic (`../9583-aec-android-emulator/`) and
the physical iPhone is gated on OS-level human taps. On Android **no human was
needed**: `pm grant` grants the mic permission, volume keys drive the loudness,
and CDP over `adb forward localabstract:webview_devtools_remote_<pid>` drives
the committed harness (`packages/ui` `window.__aecLoop`) — disproving the
"pure human-at-device" assumption for this platform.

Everything below ran the **production** path — `/api/voice/audio-frames`,
`/api/voice/playback-frames` (live playback-reference producer),
`/api/voice/aec-capture` on the on-device bun agent, and offline replay through
the production `EchoReferenceBuffer` + `NlmsEchoCanceller` + `computeErle` +
`estimateEchoDelaySamples` — the same Phase-C methodology as the accepted
macOS bundle (`../9583-aec-macos/`).

## What is PROVEN on the physical device

1. **Real speaker→air→mic acoustic loop with the live playback-reference
   producer** (acceptance row 1): `echoReferenceWired: true`,
   `playbackFramesReceived: 1109`, `playbackSamplesReceived: 354 880` (22.2 s @
   16 kHz), `lastPlaybackFrameAt` advancing, 1155 mic + 1155 playback frames
   per pass, `shipError: null` (see `aec-loop-result-*.json`,
   `statusBefore`/`statusAfter`). Unlike the emulator leg, the mic capture is
   genuinely acoustic: warmup seconds sit at the 0.021 RMS room floor and jump
   to 0.074 RMS when the speaker plays (~11 dB echo over floor;
   `pixel6a-mic-characterization.json`). OS echo cancellation / NS / AGC were
   disabled and verified via `trackSettings` in the result JSON.
2. **Measured playback→mic delay** (acceptance row 3): ~**380–410 ms** on the
   WebView pump path, consistently across five runs and two builds
   (offline production estimator: 6380/6528/6467/6217/6395/6235 samples;
   ERLE-optimal fixed delay per `sweep-delay-erle.ts`: 6440–6500, 6100–6160,
   6160–6280). The delay **wanders within a run**: 382 → 404 → 400 ms across a
   19 s capture (`pixel6a-echo-only-lag-trajectory.txt`) — ~21 ms of drift,
   larger than the entire 16 ms NLMS filter span.
3. **Echo-only ERLE, AEC off vs on** (acceptance row 2): AEC off = raw mic =
   0 dB by definition. AEC on, replayed at the best fixed delay for the
   capture: **converged-half +3.3…+5.5 dB** (linear NLMS, three runs) — the
   same shape as the accepted macOS loop (early divergence, late convergence);
   at the delay the session actually locked the replay is strongly negative
   (details below — that gap is the finding).
4. **Double-talk pass, near-end not crushed** (acceptance row 2): with real
   overlapping near-end speech (17.3 s of a distinct talker at comparable
   level; near RMS 0.075 → 0.094), matched-filter near-end preservation is
   **+7.2 dB mean over 17 voiced windows** (`near-end-preservation.ts`,
   0 dB = untouched) — the DTD keeps the canceller from learning/cancelling
   the near talker. Caveat: at the mis-locked delay the filter adds noise
   (overall ERLE −20.8 dB), so the output is *preserved but polluted*.
5. **Harness validity control**: a synthetic echo at the measured delay
   (6467 samples), realistic gain (0.35) and the measured room floor (0.02)
   through the identical replay chain converges to **+9.9 dB converged-half —
   its noise-floor-limited ceiling** (`aec-synth-control.ts`,
   `aec-synth-control-output.txt`). The measurement plumbing is sound; the
   device numbers are findings, not artifacts.

## Bugs this capture surfaced (fixed in this branch)

1. **Self-calibration search ceiling below the real Android delay** —
   `ECHO_CAL_MAX_LAG_SAMPLES` was 4 800 samples (300 ms), but the true Pixel 6a
   WebView-path delay is ~380–410 ms. The one-shot calibration therefore locked
   a **cap-edge** lag (4765/4782 ≈ 298 ms, confidence 0.32 — barely over the
   0.3 gate) and pinned an ~85 ms misalignment forever; with 256 filter taps
   (16 ms) the NLMS then *diverges* (echo-only replay at the locked delay:
   converged-half **−12 dB** vs **+3.3…+5.5 dB** at the true delay — compare
   `pixel6a-echo-only-cal300ms-bug-*` vs the sweep). Fixed in
   `live-diarization-session.ts`: search ceiling 300 ms → **500 ms**,
   calibration window 0.75 s → 1 s, and **cap-edge locks are rejected** (a
   peak within one frame of the ceiling means the true delay is likely beyond
   it). Unit tests cover a 400 ms calibration and the cap-edge refusal.
2. **No near-end injection path for a headless double-talk pass** — the
   original driver spoke the near-end from the host (`say`, macOS-only); this
   host has no audio output. On-device alternatives fail: Android WebView's
   `HTMLMediaElement` rejects `data:` URLs (`NotSupportedError`) and a second
   `AudioContext` created over CDP renders **silently** while the harness
   context holds the output stream (verified: near-end absent from the mic,
   corr 0.014). Fixed with a `nearEndAudioUrl` option in the committed harness
   (`packages/ui/src/voice/aec-loop-harness.ts`): same context, connected
   straight to `destination`, **not** through the playback tap — acoustically
   present, absent from the reference (unit-tested hash parsing).

## Honest limitations

- **Remaining accuracy gap (open engineering, not fixed here):** even with the
  ceiling fixed, the in-range one-shot lock (5479 = 342 ms, conf 0.344) is
  still ~45 ms off the whole-run optimum — early-utterance correlation is weak
  (0.06–0.27) on this hardware and the delay itself drifts ~21 ms within a
  run, so **no single constant (and no one-shot lock) can align a 16 ms filter
  on this transport**. Robust Android AEC needs continuous/multi-window delay
  tracking or the hardware-timestamped native far-end tap (#11562 JNI path,
  #11372) rather than the WebView pump path measured here.
- `PLATFORM_PLAYBACK_DELAY_DEFAULTS.android` (45 ms) was deliberately **not**
  replaced with ~400 ms: the measured value is a property of the *WebView
  pump-path transport* (ScriptProcessor block latency + WebView output
  buffering), not of the native AudioTrack/AudioRecord path the seed also
  serves, and the measured wander means no constant is truthful. The seed line
  now carries the measured evidence as a comment; the actionable fix was the
  calibration ceiling above.
- **Uncontrolled room**: a real, untreated room next to a workstation (floor
  RMS 0.021); nothing was acoustically staged. Ambient noise is part of the
  capture, exactly as production would see it.
- **Far-end speech is a WAV, not on-device TTS**: the fused
  `libelizainference.so` in this build fails to relocate on the device
  (`__register_atfork: symbol not found` — see `pixel6a-logcat-excerpt.txt`),
  so `/api/tts/local-inference` 502s and the far-end uses the harness's
  `audioUrl` seam (the macOS bundle's `farend-16k.wav`), same as the emulator
  leg. The subject under test — transport, reference producer, AEC seam — is
  unchanged; the pure-TS AEC capture path works lib-less by design (#11830).
  The relocation failure is tracked as a separate artifact/build issue.
- **Near-end radiates from the same loudspeaker** as the far-end (the host has
  no speakers): it is uncorrelated with the reference — the property that
  matters to the canceller — but it is not a spatially separate talker.
- The full-volume run (`*-volmax-*`, media volume 25/25, near RMS 0.22, peak
  0.955) is kept as a supplementary datapoint on loudspeaker nonlinearity; the
  canonical captures use 11/25 (~44 %), comparable to the accepted macOS run.

## Files

- `aec-loop-result-{echo-only,double-talk}.json` — canonical device results
  (fix build): agent aec-capture near/far PCM + delivery counters + status
  DTOs + run log + `trackSettings`. Page-side PCM copies stripped (audio is in
  the wavs).
- `pixel6a-{echo-only,double-talk}-{near-mic,far-reference,residual-linear,residual-suppressed}.wav`
  — 16 kHz mono; listen to `near-mic` to hear the real room echo (and, in
  double-talk, the second talker).
- `pixel6a-{echo-only,double-talk}-erle-report.json` — production-replay
  reports (delay estimates, ERLE series, status DTOs) at the delay the session
  locked (5479).
- `pixel6a-echo-only-optimal-delay-{erle-report.json,residual-linear.wav,residual-suppressed.wav}`
  — the same capture replayed at the sweep-optimal delay 6160
  (`--delay 6160`): converged-half **+3.32 dB linear / +4.15 dB suppressed**;
  listen to the residual — the echo audibly decays below the raw mic level in
  the second half. The delta between this and the locked-delay report IS the
  calibration-accuracy finding.
- `pixel6a-echo-only-lag-trajectory.txt` — within-run delay drift.
- `*-cal300ms-bug-*` — pre-fix captures demonstrating the cap-edge mis-lock
  (bug evidence). `*-volmax-*` — full-volume supplementary run.
- `aec-synth-control.ts` / `aec-synth-control-output.txt` — validity control.
- `pixel6a-mic-characterization.json` — floor/echo levels + driver gotchas.
- `pixel6a-aec-run-screenrecord.mp4`, `pixel6a-app-running.png`,
  `pixel6a-logcat-excerpt.txt` — the booted app during the canonical run.

## Reproduce

```bash
# build + install (eliza brand)
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ELIZA_NAMESPACE=eliza \
  bun run --cwd packages/app build:android
adb -s <serial> install -r -g \
  packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk
adb -s <serial> shell am start -n ai.elizaos.app/.MainActivity   # wait for the agent

# both passes (echo-only + double-talk), 44 % media volume
bun .github/issue-evidence/9583-aec-device-loops/driver/android-physical-driver.mjs \
  --serial <serial> \
  --far-end-wav .github/issue-evidence/9583-aec-macos/farend-16k.wav \
  --near-end-wav <distinct-speech-16k.wav> \
  --out .github/issue-evidence/11373-aec-android --volume 0.44

# measurement + analysis (offline, production classes)
D=.github/issue-evidence/9583-aec-device-loops/driver
E=.github/issue-evidence/11373-aec-android
bun $D/measure-device-erle.ts   --input $E/aec-loop-result-echo-only.json  --out $E --label pixel6a-echo-only
bun $D/measure-device-erle.ts   --input $E/aec-loop-result-double-talk.json --out $E --label pixel6a-double-talk
bun $D/sweep-delay-erle.ts      --input $E/aec-loop-result-echo-only.json  --from 5200 --to 6700 --step 60
bun $D/lag-trajectory.ts        --input $E/aec-loop-result-echo-only.json
bun $D/near-end-preservation.ts --input $E/aec-loop-result-double-talk.json --near-source <near-16k.wav>
bun $E/aec-synth-control.ts
```

Driver gotchas learned on this device: `cmd media_session volume --set`
reports success but does not apply (use volume keyevents with read-verify —
the committed driver does); `adb install -r` can be raced by another session's
pipeline on a shared host — verify `dumpsys package … lastUpdateTime` and the
extracted `files/agent/agent-bundle.js` before trusting a run.
