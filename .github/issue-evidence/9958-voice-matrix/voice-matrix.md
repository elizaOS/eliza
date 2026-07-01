# Voice Live Matrix

Generated: 2026-06-30T07:13:48.071Z
Host: darwin arm64 (Shaws-MacBook-Pro.local)

| Cell | Status | Platform | Class | Probe / Result | Command |
|---|---:|---|---|---|---|
| `web.fake-mic.roundtrip` | pending | web | live-client-audio-barge-in | Chromium fake-device mic lane is host-runnable | `bun run --cwd packages/app test:e2e test/ui-smoke/voice-realaudio.spec.ts` |
| `web.fake-mic.transcript-roundtrip` | pending | web | transcripts-roundtrip-voice-control-bridge-parity | Chromium fake-device mic lane is host-runnable | `bun run --cwd packages/app test:e2e test/ui-smoke/transcript-realaudio.spec.ts` |
| `web.workbench.respond-no-respond` | pending | web | chime-in-matrix | Chromium fake-device mic lane is host-runnable | `bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-respond-no-respond.spec.ts` |
| `linux.fused-acoustic.workbench-real` | skip | linux | real-acoustic-workbench | requires Linux runner; current=darwin | `bun run --cwd plugins/plugin-local-inference voice:workbench --real` |
| `linux.fused-acoustic.barge-in` | skip | linux | barge-in | requires Linux runner; current=darwin | `bun run --cwd plugins/plugin-local-inference voice:bargein-bench` |
| `macos.electrobun.live-roundtrip` | skip | macos-electrobun | desktop-live-voice | set ELIZA_VOICE_MACOS_ELECTROBUN_READY=1 on a macOS Electrobun voice runner with loopback mic/audio capture | `bun run --cwd packages/app test:desktop:voice` |
| `windows.electrobun.live-roundtrip` | skip | windows-electrobun | desktop-live-voice | requires Windows runner; current=darwin | `bun run --cwd packages/app test:desktop:voice` |
| `ios.sim-or-device.voice-roundtrip` | skip | ios | mobile-live-voice | set ELIZA_VOICE_IOS_READY=1 after booting an iOS simulator and installing the current app build with voice assets | `bun run --cwd packages/app capture:ios-sim -- --issue 9958 --slug voice-ios` |
| `ios.talkmode.native-bridge` | pending | ios | native-bridge-unit | macOS Swift Package test toolchain is available | `swift test --disable-index-store --package-path plugins/plugin-native-talkmode/ios` |
| `ios.swabble.native-bridge` | pending | ios | native-bridge-unit | macOS Swift Package test toolchain is available | `swift test --disable-index-store --package-path plugins/plugin-native-swabble/ios` |
| `android.device.voice-roundtrip` | skip | android | mobile-live-voice | set ELIZA_VOICE_ANDROID_READY=1 on an Android device runner with the current APK and voice assets installed | `bun run --cwd packages/app test:e2e:android:local` |
| `android.talkmode.native-bridge` | pending | android | native-bridge-unit | Android voice bridge Gradle project exists | `./gradlew -p ../../../scripts/android-voice-bridge-gradle :elizaos-capacitor-talkmode:testDebugUnitTest` |
| `android.swabble.native-bridge` | pending | android | native-bridge-unit | Android voice bridge Gradle project exists | `./gradlew -p ../../../scripts/android-voice-bridge-gradle :elizaos-capacitor-swabble:testDebugUnitTest` |
| `wake.openwakeword.real-head` | skip | linux | wakeword-device-gap | ELIZA_VOICE_OPENWAKEWORD_REPORT is not set to a reviewed real-head openWakeWord JSON report | `node packages/scripts/voice-openwakeword-eval.mjs` |
| `stt.stage-b.apple-sfspeech` | pending | macos-electrobun | stt-evaluation | macOS on-device SFSpeechRecognizer + say/afconvert available for a real Stage-B latency/WER measurement | `node packages/scripts/stage-b-stt-bench.mjs` |
| `stt.stage-b.evaluation` | skip | android | stt-evaluation | ELIZA_VOICE_STAGE_B_REPORT is not set to a reviewed iOS+Android+fused ASR Stage-B JSON report | `node packages/scripts/voice-stage-b-eval.mjs` |

## Summary

- Pass: 0
- Fail: 0
- Pending: 8
- Skip: 8

Hardware-unavailable cells are explicit `skip` rows. They are not evidence of platform coverage.
