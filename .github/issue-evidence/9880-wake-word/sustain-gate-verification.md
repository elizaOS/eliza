# Sustain Gate Verification — #9880

This closes the actionable finding from the Linux-native real-audio tier:
`OpenWakeWordDetector` used to fire on the first frame whose score crossed the
threshold. The existing evidence shows true "eliza" positives sustain for 10-17
frames over threshold, while hard negatives spike for at most 7 frames.

## Change

- Added `WakeWordConfig.minActivationFrames`.
- Defaulted it to `8` consecutive frames at or above `threshold`.
- Reset the activation streak on below-threshold frames, during refractory
  cooldown, and on detector reset.
- Preserved one-frame firing as an explicit test-only/configurable mode for
  callers that need the old behavior.

## Verification

Commands run on 2026-06-29:

```bash
bun install
node packages/shared/scripts/generate-keywords.mjs --target ts
bun run --cwd packages/contracts build
bun run --cwd plugins/plugin-local-inference test src/services/voice/wake-word.test.ts
bun run --cwd plugins/plugin-local-inference typecheck
bun run --cwd plugins/plugin-local-inference lint:check
```

Results:

- `wake-word.test.ts`: 15 tests passed, including the new regression where 7 hot
  frames do not fire and the next sustained 8-frame run does fire.
- `plugins/plugin-local-inference typecheck`: passed.
- `plugins/plugin-local-inference lint:check`: passed.

Full `plugins/plugin-local-inference test` was also attempted. It failed outside
the wake-word path: imagegen publishing tests could not find
`packages/chip/ELIZA_1_BUNDLE_EXTRAS.json` after artifact cleanup, and an
existing `voice-profile-store-merge-split` test timed out. The focused wake-word
suite above is green.
