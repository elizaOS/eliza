# Voice Live Matrix

Generated: 2026-06-30T00:38:51.994Z
Host: darwin arm64 (Shaws-MacBook-Pro.local)

| Cell | Status | Platform | Class | Probe / Result | Command |
|---|---:|---|---|---|---|
| `android.device.voice-roundtrip` | skip | android | mobile-live-voice | set ELIZA_VOICE_ANDROID_READY=1 on an Android device runner with the current APK and voice assets installed | `bun run --cwd packages/app test:e2e:android:local` |
| `android.talkmode.native-bridge` | pass | android | native-bridge-unit | command passed (2026-06-30T00:38:10.190Z) | `./gradlew -p ../../../scripts/android-voice-bridge-gradle :elizaos-capacitor-talkmode:testDebugUnitTest` |
| `android.swabble.native-bridge` | pass | android | native-bridge-unit | command passed (2026-06-30T00:38:51.752Z) | `./gradlew -p ../../../scripts/android-voice-bridge-gradle :elizaos-capacitor-swabble:testDebugUnitTest` |
| `stt.stage-b.evaluation` | skip | android | stt-evaluation | Stage-B STT battery/latency evaluation needs paired iOS+Android device runners and power telemetry | `bun packages/scripts/voice-matrix.mjs --stage-b-eval-placeholder` |

## Summary

- Pass: 2
- Fail: 0
- Pending: 0
- Skip: 2

Hardware-unavailable cells are explicit `skip` rows. They are not evidence of platform coverage.
