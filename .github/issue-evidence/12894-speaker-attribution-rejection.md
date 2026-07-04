# Issue #12894 - Speculative Speaker Attribution Rejection

## Change

- `VoiceProfileStore.beginMatch()` now observes the eager `result` promise immediately while returning the same promise unchanged.
- `VoiceAttributionPipeline.beginTurn()` regression coverage uses a fake speaker encoder whose `encode()` rejects after the first speculative window is pushed.

## Manual Review

- Reviewed the `beginMatch()` promise path by hand: the added `catch` is side-effect-only, so abandoned handles no longer emit `unhandledRejection`, while explicit `await handle.result` still receives the original rejection.
- Reviewed the new regression assertion: it records `process.on("unhandledRejection")`, abandons the speculative handle through the pipeline path, flushes the event loop, asserts no unhandled rejection, then verifies `speculativeMatch.result` still rejects with the encoder failure.

## Verification

```bash
bun install --no-save --ignore-scripts --cache-dir "$HOME/.bun-install-cache-deploy"
node packages/scripts/ensure-workspace-symlinks.mjs
node packages/shared/scripts/generate-keywords.mjs --target ts
bun run --cwd packages/contracts build
bun run --cwd packages/cloud/routing build
bun run --cwd plugins/plugin-local-inference test src/services/voice/speaker/attribution-pipeline.incremental.test.ts __tests__/voice-profile-store.test.ts
bun run --cwd plugins/plugin-local-inference typecheck
git diff --check
```

Results:

- Focused Vitest: 2 files passed, 28 tests passed.
- `plugins/plugin-local-inference` typecheck: passed.
- `git diff --check`: passed.

## Evidence N/A

- Real audio capture: N/A - no audio device, native encoder, diarizer, or capture path changed.
- Hardware/mobile/desktop capture: N/A - no platform bridge or UI surface changed.
- Screenshots/video/frontend logs: N/A - non-UI runtime regression.
- Real-LLM trajectories: N/A - no model prompt/action/provider behavior changed.
