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

Use `--require-green` only on a lane where every selected hardware dependency is
known to be present; it turns `pending` or `skip` into a failing exit.

## Cells

| Cell | Existing runner | Evidence |
| --- | --- | --- |
| `web.fake-mic.roundtrip` | `packages/app` Playwright `voice-realaudio.spec.ts` with Chromium fake audio capture | real browser getUserMedia/WAV encode/client ASR post, local-inference Web Audio TTS start, START_TRANSCRIPTION barge-in disconnect, and second real WAV drain |
| `web.fake-mic.transcript-roundtrip` | `packages/app` Playwright `transcript-realaudio.spec.ts` | capture -> transcript record -> player -> chat attachment, plus agent-action START/STOP parity with the slash/button path |
| `web.workbench.respond-no-respond` | headful workbench Playwright scenario | chime-in should-respond/should-not-respond UI behavior |
| `linux.fused-acoustic.workbench-real` | `plugins/plugin-local-inference voice:workbench --real` | fused ASR, diarization, VAD, Kokoro TTS, noisy and multi-speaker workbench report |
| `linux.fused-acoustic.barge-in` | `plugins/plugin-local-inference voice:bargein-bench` | cancellation/latency harness for barge-in |
| `macos.electrobun.live-roundtrip` | headed Electrobun runner plus `capture:macos-desktop` | screen/video/log artifact when `ELIZA_VOICE_MACOS_ELECTROBUN_READY=1` |
| `windows.electrobun.live-roundtrip` | headed Electrobun runner plus `capture:windows-desktop` | screen/video/log artifact when `ELIZA_VOICE_WINDOWS_ELECTROBUN_READY=1` |
| `ios.sim-or-device.voice-roundtrip` | installed iOS simulator/device build plus `capture:ios-sim` | simulator screenshot/video/log when `ELIZA_VOICE_IOS_READY=1` |
| `ios.talkmode.native-bridge` | `swift test --package-path plugins/plugin-native-talkmode/ios` | TalkMode transcript/permission/state/barge-in bridge tests |
| `ios.swabble.native-bridge` | `swift test --package-path plugins/plugin-native-swabble/ios` | Swabble wake-firing -> JS bridge event tests |
| `android.device.voice-roundtrip` | `packages/app test:e2e:android:local` | real WebView on-device STT -> agent -> TTS self-test |
| `android.talkmode.native-bridge` | generated Android Gradle `:elizaos-capacitor-talkmode:testDebugUnitTest` | TalkMode capture lifecycle/transcript/permission/barge-in bridge tests |
| `android.swabble.native-bridge` | generated Android Gradle `:elizaos-capacitor-swabble:testDebugUnitTest` | Swabble wake-firing -> JS bridge event tests |
| `wake.openwakeword.real-head` | gated real openWakeWord head run | idle wake, always-on inert wake, and mid-transcription non-corruption evidence |
| `stt.stage-b.evaluation` | paired iOS/Android device benchmark | iOS `SFSpeechRecognizer`, Android `SpeechRecognizer`, and fused ASR latency/battery/accept matrix |

## Hardware Gates

The runner uses environment gates for cells that cannot be proven from a generic
developer laptop:

| Gate | Meaning |
| --- | --- |
| `ELIZA_VOICE_MACOS_ELECTROBUN_READY=1` | current macOS runner has a built Electrobun app, loopback mic/audio capture, and permission grants |
| `ELIZA_VOICE_WINDOWS_ELECTROBUN_READY=1` | current Windows runner has a built Electrobun app, loopback mic/audio capture, and permission grants |
| `ELIZA_VOICE_IOS_READY=1` | current macOS runner has a freshly installed iOS simulator/device build with voice assets |
| `ELIZA_VOICE_ANDROID_READY=1` | current runner has an attached Android device/emulator, current APK, voice assets, and granted mic permissions |
| `ELIZA_OPENWAKEWORD_REAL_READY=1` | current runner has the real openWakeWord head and audio fixture/device path |
| `ELIZA_INFERENCE_LIBRARY` + `ELIZA_ASR_BUNDLE` | Linux fused real-service runner has the provisioned local-inference bundle |

The matrix report records these gates in the `probe.reason` field. This keeps
Linux green separate from missing macOS/iOS/Android evidence.

## TTS Policy

Kokoro TTS stays unchanged. This matrix verifies live voice breadth and Stage-B
STT choices; it does not replace the provider defaults in
`voice-provider-defaults.ts`.
