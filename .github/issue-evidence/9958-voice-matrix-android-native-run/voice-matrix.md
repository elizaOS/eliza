# Voice Live Matrix

Generated: 2026-06-30T06:47:00.567Z
Host: darwin arm64 (Shaws-MacBook-Pro.local)

| Cell | Status | Platform | Class | Probe / Result | Command |
|---|---:|---|---|---|---|
| `android.device.voice-roundtrip` | skip | android | mobile-live-voice | set ELIZA_VOICE_ANDROID_READY=1 on an Android device runner with the current APK and voice assets installed | `bun run --cwd packages/app test:e2e:android:local` |
| `android.talkmode.native-bridge` | pass | android | native-bridge-unit | command passed (2026-06-30T06:46:59.048Z) | `./gradlew -p ../../../scripts/android-voice-bridge-gradle :elizaos-capacitor-talkmode:testDebugUnitTest` |
| `android.swabble.native-bridge` | pass | android | native-bridge-unit | command passed (2026-06-30T06:47:00.561Z) | `./gradlew -p ../../../scripts/android-voice-bridge-gradle :elizaos-capacitor-swabble:testDebugUnitTest` |
| `stt.stage-b.evaluation` | skip | android | stt-evaluation | ELIZA_VOICE_STAGE_B_REPORT is not set to a reviewed iOS+Android+fused ASR Stage-B JSON report | `node packages/scripts/voice-stage-b-eval.mjs` |

## Summary

- Pass: 2
- Fail: 0
- Pending: 0
- Skip: 2

Hardware-unavailable cells are explicit `skip` rows. They are not evidence of platform coverage.
