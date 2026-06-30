# #9958 iOS Ready Gate Probe

Generated on 2026-06-30 after tightening the iOS voice matrix probe. Command:

```bash
ELIZA_VOICE_IOS_READY=1 \
  bun run voice:matrix -- --platform ios.sim-or-device.voice-roundtrip \
  --out .github/issue-evidence/9958-voice-ios-ready-gated-probe
```

Manual review:

- `voice-matrix.json`, `voice-matrix.md`, and `index.html` were opened after generation.
- The selected iOS live voice cell is `skip`, not `pass`, because this Mac has no booted iOS simulator.
- A separate local assertion ran the same selected cell with `--require-green`; it exited with code `1`, proving an opted-in hardware lane cannot green-pass this missing simulator/app state.
