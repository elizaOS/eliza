# #9958 Android Ready Gate Probe

Generated on 2026-06-30 after tightening the Android voice matrix probe. Command:

```bash
ELIZA_VOICE_ANDROID_READY=1 \
  bun run voice:matrix -- --platform android.device.voice-roundtrip \
  --out .github/issue-evidence/9958-voice-android-ready-gated-probe
```

Manual review:

- `voice-matrix.json`, `voice-matrix.md`, and `index.html` were opened after generation.
- The selected Android live voice cell is `skip`, not `pass`, because this host has no Android device/emulator attached in `device` state.
- A separate local assertion ran the same selected cell with `--require-green`; it exited with code `1`, proving an opted-in hardware lane cannot green-pass this missing device/app state.
