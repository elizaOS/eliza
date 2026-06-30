# Voice Live Matrix

Issue #9958 defines the live-voice verification product surface. This document
is the canonical matrix and `bun run voice:matrix` is the canonical artifact
producer. The matrix is evidence-oriented: every cell is either `pass`, `fail`,
`pending`, or `skip` with a hardware-unavailable reason. A skipped cell is never
platform coverage.

## Dimensions

The full product is:

| Dimension | Values |
| --- | --- |
| platform | `web`, `linux`, `macos-electrobun`, `windows-electrobun`, `ios`, `android` |
| transcription-state | `off`, `on` |
| chime-in | `should-respond`, `should-not-respond` |
| wakeword-context | `idle-wake`, `already-listening-wake-inert`, `mid-transcription-wake` |
| noise/rejection | `quiet`, `noisy-reverberant`, `echo-self-voice`, `overlapping-speech` |
| voices | `owner`, `enrolled-contact`, `unknown`, `multi-speaker` |

The matrix runner records these dimensions per cell rather than expanding every
Cartesian-product row into a separate CI job. The existing Voice Workbench
scenarios cover the multi-row acoustic classes; platform live cells prove the
device boundary.

## Canonical Command

```bash
bun run voice:matrix
```

By default the command probes the current host and writes:

```text
.github/issue-evidence/9958-voice-matrix/
  voice-matrix.json
  voice-matrix.md
  index.html
```

Use `--run` to execute available cell commands:

```bash
bun run voice:matrix -- --run --platform web
bun run voice:matrix -- --run --platform android
bun run voice:matrix -- --run --platform linux
```

Use `--require-green` on any opted-in hardware lane; it turns `pending` or
`skip` into a failing exit so a readiness variable cannot produce green evidence
while a device, app install, model, or reviewed report is missing.

To validate the Stage-B STT benchmark cell, point the matrix at the reviewed
report:

```bash
ELIZA_VOICE_STAGE_B_REPORT=.github/issue-evidence/9958-stage-b/report.json \
  bun run voice:matrix -- --run --platform stt.stage-b.evaluation
```

To validate the real openWakeWord head wake-context cell, point the matrix at the
reviewed report:

```bash
ELIZA_VOICE_OPENWAKEWORD_REPORT=.github/issue-evidence/9958-openwakeword/report.json \
  bun run voice:matrix -- --run --platform wake.openwakeword.real-head
```

## Cells

| Cell | Existing runner | Evidence |
| --- | --- | --- |
| `web.fake-mic.roundtrip` | `packages/app` Playwright `voice-realaudio.spec.ts` with Chromium fake audio capture | real browser getUserMedia/WAV encode/client ASR post, local-inference Web Audio TTS start, START_TRANSCRIPTION barge-in disconnect, and second real WAV drain |
| `web.fake-mic.transcript-roundtrip` | `packages/app` Playwright `transcript-realaudio.spec.ts` | capture -> transcript record -> player -> chat attachment, plus agent-action START/STOP parity with the slash/button path |
| `web.workbench.respond-no-respond` | headful workbench Playwright scenario | chime-in should-respond/should-not-respond UI behavior |
| `linux.fused-acoustic.workbench-real` | `plugins/plugin-local-inference voice:workbench --real` | fused ASR, diarization, VAD, Kokoro TTS, noisy and multi-speaker workbench report |
| `linux.fused-acoustic.barge-in` | `plugins/plugin-local-inference voice:bargein-bench` | cancellation/latency harness for barge-in |
| `macos.electrobun.live-roundtrip` | packaged Electrobun voice self-test via `packages/app test:desktop:voice` | real desktop `voice-selftest` ASR -> agent SSE -> local TTS report plus screenshot/log artifact when `ELIZA_VOICE_MACOS_ELECTROBUN_READY=1` and `ELIZA_VOICE_DESKTOP_API_BASE` points at a real app-core API |
| `windows.electrobun.live-roundtrip` | packaged Electrobun voice self-test via `packages/app test:desktop:voice` | real desktop `voice-selftest` ASR -> agent SSE -> local TTS report plus screenshot/log artifact when `ELIZA_VOICE_WINDOWS_ELECTROBUN_READY=1` and `ELIZA_VOICE_DESKTOP_API_BASE` points at a real app-core API |
| `ios.sim-or-device.voice-roundtrip` | installed iOS simulator build plus `capture:ios-sim` | simulator screenshot/video/log when `ELIZA_VOICE_IOS_READY=1`, a booted iOS simulator exists, and the current app ID is installed |
| `ios.talkmode.native-bridge` | `swift test --disable-index-store --package-path plugins/plugin-native-talkmode/ios` | TalkMode transcript/permission/state/barge-in bridge tests |
| `ios.swabble.native-bridge` | `swift test --disable-index-store --package-path plugins/plugin-native-swabble/ios` | Swabble wake-firing -> JS bridge event tests |
| `android.device.voice-roundtrip` | `packages/app test:e2e:android:local` | real WebView on-device STT -> agent -> TTS self-test |
| `android.talkmode.native-bridge` | `./gradlew -p ../../../scripts/android-voice-bridge-gradle :elizaos-capacitor-talkmode:testDebugUnitTest` | TalkMode capture lifecycle/transcript/permission/barge-in bridge tests |
| `android.swabble.native-bridge` | `./gradlew -p ../../../scripts/android-voice-bridge-gradle :elizaos-capacitor-swabble:testDebugUnitTest` | Swabble wake-firing -> JS bridge event tests |
| `wake.openwakeword.real-head` | `packages/scripts/voice-openwakeword-eval.mjs` validating a reviewed real-head report | idle wake opens the listen window, always-on wake is inert, and mid-transcription wake does not corrupt the transcript |
| `stt.stage-b.apple-sfspeech` | `node packages/scripts/stage-b-stt-bench.mjs` (macOS) | **measured** on-device `SFSpeechRecognizer` latency/RTF/WER over on-device-synthesised speech (quiet + 10 dB noise), `.github/issue-evidence/9958-stt-stage-b-eval/` |
| `stt.stage-b.evaluation` | `packages/scripts/voice-stage-b-eval.mjs` validating a paired device benchmark report | iOS `SFSpeechRecognizer`, Android `SpeechRecognizer`, and fused ASR latency/battery/accept matrix with reviewed artifacts |

## Hardware Gates

The runner uses environment gates for cells that cannot be proven from a generic
developer laptop:

| Gate | Meaning |
| --- | --- |
| `ELIZA_VOICE_MACOS_ELECTROBUN_READY=1` | current macOS runner has a built Electrobun app, loopback mic/audio capture, and permission grants |
| `ELIZA_VOICE_WINDOWS_ELECTROBUN_READY=1` | current Windows runner has a built Electrobun app, loopback mic/audio capture, and permission grants |
| `ELIZA_VOICE_DESKTOP_API_BASE` | real app-core API base used by packaged desktop voice self-test; required for macOS/Windows Electrobun live cells |
| `ELIZA_VOICE_IOS_READY=1` | current macOS runner has a booted iOS simulator with the current app build and voice assets installed; the matrix verifies the booted simulator and installed app ID before capture |
| `ELIZA_VOICE_IOS_APP_ID` / `ELIZA_IOS_APP_ID` | optional app ID override for the iOS install check; defaults to `packages/app/app.config.ts` (`ai.elizaos.app`) |
| `ELIZA_VOICE_ANDROID_READY=1` | current runner has an attached Android device/emulator, current APK, voice assets, and granted mic permissions |
| `ELIZA_VOICE_OPENWAKEWORD_REPORT` | reviewed openWakeWord real-head JSON report using schema `eliza_voice_openwakeword_eval_v1`; required cases are `idle-wake`, `already-listening-wake-inert`, and `mid-transcription-wake` |
| `ELIZA_INFERENCE_LIBRARY` + `ELIZA_ASR_BUNDLE` | Linux fused real-service runner has the provisioned local-inference bundle |
| `ELIZA_VOICE_STAGE_B_REPORT` | reviewed Stage-B JSON report using schema `eliza_voice_stage_b_stt_eval_v1`; required backends are `ios-sfspeechrecognizer`, `android-speechrecognizer`, and `fused-asr` |

The matrix report records these gates in the `probe.reason` field. This keeps
Linux green separate from missing macOS/iOS/Android evidence.

The openWakeWord report must mark `realHardware: true` and `realHead: true`.
Each required case must identify the device/build/openWakeWord model, record the
real audio source and duration, include manually reviewed artifacts, and prove
the case-specific observation: idle wake opened the listen window, wake while
already listening did not open a duplicate window, and wake during transcription
did not corrupt or drop transcript tokens.

The Stage-B report is intentionally stricter than a plain benchmark dump. Each
backend run must mark `realHardware: true`, identify the build and device, record
latency, `msPerFrame`, true/false accepts, WER, battery or power telemetry, and
list manually reviewed artifact paths.

## TTS Policy

Kokoro TTS stays unchanged. This matrix verifies live voice breadth and Stage-B
STT choices; it does not replace the provider defaults in
`voice-provider-defaults.ts`.
