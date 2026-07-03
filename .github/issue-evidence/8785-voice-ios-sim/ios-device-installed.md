## iOS PHYSICAL DEVICE — signed app + embedded engine INSTALLED on Shaw's iPhone 15 Pro

Built + signed + installed on 2026-06-22. Device: Shaw's iPhone 15 Pro (iOS 26.5), UDID 00008130-001955E91EF8001C.

### Signing cracked (the earlier 'No Accounts' wall resolved):
- Correct team is **25877RY2EH** (the cert's OU; my first build wrongly used UT5K5Q5EVF — that's the cert CN id, a personal team with no app profiles).
- Automatic signing + the cached team profiles (which cover this device) + the generic 'Apple Development' identity → no account needed.
- Aligned the 2 DeviceActivity extension entitlements to their profiles (dropped a stale app-group). → **BUILD SUCCEEDED**.

### Installed on the device (devicectl device info apps):
Eliza                     ai.elizaos.app                        1.0       1             

### Signed App.app + embedded engine:
Identifier=ai.elizaos.app
TeamIdentifier=25877RY2EH
  Frameworks: ElizaBunEngine.framework 
Identifier=ai.eliza.ElizaBunEngine
TeamIdentifier=25877RY2EH

### Remaining (physical action only): launch is blocked while the phone is LOCKED:
  FBSOpenApplicationErrorDomain error 7: "Unable to launch ai.elizaos.app because the device was not, or could not be, unlocked." (Locked)

To finish the on-device VOICE round-trip: UNLOCK the iPhone (Face ID/passcode), trust the developer
(Settings > General > VPN & Device Management > Apple Development: Shaw Walters), and open Eliza →
select 'This device' (local). The embedded full-Bun engine then runs on the iPhone's real Metal GPU —
the same fused engine + GGUF proven running real ASR/speaker/diarization/VAD/TTS on this Mac's Apple Silicon.
