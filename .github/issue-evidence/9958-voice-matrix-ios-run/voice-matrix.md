# Voice Live Matrix

Generated: 2026-06-29T20:52:27.019Z
Host: darwin arm64 (Shaws-MacBook-Pro.local)

| Cell | Status | Platform | Class | Probe / Result | Command |
|---|---:|---|---|---|---|
| `ios.sim-or-device.voice-roundtrip` | skip | ios | mobile-live-voice | set ELIZA_VOICE_IOS_READY=1 after installing a current iOS simulator/device build with voice assets | `bun run --cwd packages/app capture:ios-sim -- --issue 9958 --slug voice-ios` |
| `ios.talkmode.native-bridge` | pass | ios | native-bridge-unit | command passed (2026-06-29T20:52:26.366Z) | `swift test --package-path plugins/plugin-native-talkmode/ios` |
| `ios.swabble.native-bridge` | pass | ios | native-bridge-unit | command passed (2026-06-29T20:52:27.019Z) | `swift test --package-path plugins/plugin-native-swabble/ios` |

## Summary

- Pass: 2
- Fail: 0
- Pending: 0
- Skip: 1

Hardware-unavailable cells are explicit `skip` rows. They are not evidence of platform coverage.
