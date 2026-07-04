# Issue #12896 - Attribution Cancel Settles First Window

## Change

- `VoiceAttributionPipeline.beginTurn()` now wraps the speculative match handle so `cancel()` first settles the pending first-window promise with `null`, then delegates to the profile-store cancellation.
- Abort signals passed to `beginTurn()` use the same cancellation path, so an aborted speculative lookup cannot leave the first-window embed continuation suspended.
- `AudioFrameConsumer` regression coverage now drives the public `close()` path and the zero-buffer `speech-end` path with a real `VoiceAttributionPipeline` and real `VoiceProfileStore`.

## Manual Review

- Reviewed the wrapped cancel path by hand: normal `pushWindow()` and `finalize()` still settle the first window with audio, while close/cancel/abort settle it with `null`.
- Reviewed the new tests: they wrap `VoiceProfileStore.beginMatch()` only to observe when the real embed continuation exits, then assert both the embed continuation and speculative `result` settle through the consumer's real cancellation paths.

## Verification

```bash
bun install --no-save --ignore-scripts --cache-dir "$HOME/.bun-install-cache-deploy"
node packages/scripts/ensure-workspace-symlinks.mjs
node packages/shared/scripts/generate-keywords.mjs --target ts
bun run --cwd packages/contracts build
bun run --cwd packages/cloud/routing build
bun run --cwd plugins/plugin-local-inference test src/services/voice/audio-frame-consumer.windowed.test.ts
bunx @biomejs/biome check plugins/plugin-local-inference/src/services/voice/speaker/attribution-pipeline.ts plugins/plugin-local-inference/src/services/voice/audio-frame-consumer.windowed.test.ts
bun run --cwd plugins/plugin-local-inference typecheck
git diff --check
```

Results:

- Focused Vitest: 1 file passed, 5 tests passed.
- Biome touched-file check: passed.
- `plugins/plugin-local-inference` typecheck: passed.
- `git diff --check`: passed.

## Evidence N/A

- Real audio capture: N/A - no native audio device, FFI model, or capture transport changed.
- Hardware/mobile/desktop capture: N/A - unit-level lifecycle regression only.
- Screenshots/video/frontend logs: N/A - non-UI runtime change.
- Real-LLM trajectories: N/A - no prompt/action/provider/model behavior changed.
