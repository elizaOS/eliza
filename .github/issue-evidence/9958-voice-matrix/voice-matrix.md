# Voice Live Matrix

Generated: 2026-06-30T00:04:12.979Z
Host: darwin arm64 (Shaws-MacBook-Pro.local)

| Cell | Status | Platform | Class | Probe / Result | Command |
|---|---:|---|---|---|---|
| `web.fake-mic.roundtrip` | pending | web | live-client-audio-barge-in | Chromium fake-device mic lane is host-runnable | `bun run --cwd packages/app test:e2e test/ui-smoke/voice-realaudio.spec.ts` |
| `web.fake-mic.transcript-roundtrip` | pending | web | transcripts-roundtrip-voice-control-bridge-parity | Chromium fake-device mic lane is host-runnable | `bun run --cwd packages/app test:e2e test/ui-smoke/transcript-realaudio.spec.ts` |
| `web.workbench.respond-no-respond` | pending | web | chime-in-matrix | Chromium fake-device mic lane is host-runnable | `bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-respond-no-respond.spec.ts` |
| `linux.fused-acoustic.workbench-real` | skip | linux | real-acoustic-workbench | requires Linux runner; current=darwin | `bun run --cwd plugins/plugin-local-inference voice:workbench --real` |
| `linux.fused-acoustic.barge-in` | skip | linux | barge-in | requires Linux runner; current=darwin | `bun run --cwd plugins/plugin-local-inference voice:bargein-bench` |
| `macos.electrobun.live-roundtrip` | skip | macos-electrobun | desktop-live-voice | set ELIZA_VOICE_MACOS_ELECTROBUN_READY=1 on a macOS Electrobun voice runner with loopback mic/audio capture | `bun run --cwd packages/app capture:macos-desktop -- --issue 9958 --slug voice-macos-electrobun` |
| `windows.electrobun.live-roundtrip` | skip | windows-electrobun | desktop-live-voice | requires Windows runner; current=darwin | `bun run --cwd packages/app capture:windows-desktop -- --issue 9958 --slug voice-windows-electrobun` |
| `ios.sim-or-device.voice-roundtrip` | skip | ios | mobile-live-voice | set ELIZA_VOICE_IOS_READY=1 after installing a current iOS simulator/device build with voice assets | `bun run --cwd packages/app capture:ios-sim -- --issue 9958 --slug voice-ios` |
| `ios.talkmode.native-bridge` | pending | ios | native-bridge-unit | macOS Swift Package test toolchain is available | `swift test --disable-index-store --package-path plugins/plugin-native-talkmode/ios` |
| `ios.swabble.native-bridge` | pending | ios | native-bridge-unit | macOS Swift Package test toolchain is available | `swift test --disable-index-store --package-path plugins/plugin-native-swabble/ios` |
| `android.device.voice-roundtrip` | skip | android | mobile-live-voice | set ELIZA_VOICE_ANDROID_READY=1 on an Android device runner with the current APK and voice assets installed | `bun run --cwd packages/app test:e2e:android:local` |
| `android.talkmode.native-bridge` | skip | android | native-bridge-unit | packages/app/android is not generated; run packages/app cap:sync:android or build:android first | `./gradlew :elizaos-capacitor-talkmode:testDebugUnitTest` |
| `android.swabble.native-bridge` | skip | android | native-bridge-unit | packages/app/android is not generated; run packages/app cap:sync:android or build:android first | `./gradlew :elizaos-capacitor-swabble:testDebugUnitTest` |
| `wake.openwakeword.real-head` | skip | linux | wakeword-device-gap | ELIZA_OPENWAKEWORD_REAL_READY is not set for a real wake-word head run | `bun run --cwd plugins/plugin-local-inference voice:workbench --real` |
| `stt.stage-b.evaluation` | skip | android | stt-evaluation | Stage-B STT battery/latency evaluation needs paired iOS+Android device runners and power telemetry | `bun packages/scripts/voice-matrix.mjs --stage-b-eval-placeholder` |

## Summary

- Pass: 0
- Fail: 0
- Pending: 5
- Skip: 10

Hardware-unavailable cells are explicit `skip` rows. They are not evidence of platform coverage.
