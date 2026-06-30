# Voice Live Matrix

Generated: 2026-06-30T07:01:48.954Z
Host: darwin arm64 (Shaws-MacBook-Pro.local)

| Cell | Status | Platform | Class | Probe / Result | Command |
|---|---:|---|---|---|---|
| `ios.sim-or-device.voice-roundtrip` | skip | ios | mobile-live-voice | ELIZA_VOICE_IOS_READY=1 but no booted iOS simulator is available; boot a simulator and install the current app before capture | `bun run --cwd packages/app capture:ios-sim -- --issue 9958 --slug voice-ios` |

## Summary

- Pass: 0
- Fail: 0
- Pending: 0
- Skip: 1

Hardware-unavailable cells are explicit `skip` rows. They are not evidence of platform coverage.
