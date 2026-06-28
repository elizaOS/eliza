# #9147 Real Audio Matrix — M4 Max Local Run

Date: 2026-06-24
Branch: `fix/9147-real-audio-matrix`

Environment:
- Host: Apple M4 Max
- Fused library: `/Users/shawwalters/.local/state/eliza/local-inference/lib/libelizainference.dylib`
- Models: `/Users/shawwalters/.eliza/local-inference/models`
- Command:

```bash
bun packages/app-core/scripts/voice-attribution-smoke.ts \
  --models "$HOME/.eliza/local-inference/models" \
  --require-real
```

Result: `[voice-attribution-smoke] ALL PASS`

Key real-model checks:
- Silero VAD: real speech scored above silence (`speechMax=1.000`, `silenceMax=0.009`).
- WeSpeaker: 256-d unit-norm embeddings, deterministic repeat cosine `1.0000`, same-speaker cosine `0.844`.
- Live `selfVoiceSimilarity`: agent echo was suppressed with cosine `1.0000`.
- pyannote diarizer: real speech produced diarized segments (`segments=113`, `speakers=3`, `speechMs=4249`).
- Speaker profile pipeline: enrolled a new cluster, re-matched it to `entity-speaker-a`, and emitted `VOICE_TURN_OBSERVED`.
- Bystander gate: uncertain fresh profile failed open; refined non-owner profile suppressed; wake word overrode suppression.
- AudioFrameConsumer: segmented one turn from 863 frames, attributed a speaker, emitted `VOICE_TURN_OBSERVED`, dropped 0 frames.

Additional validation:

```bash
actionlint .github/workflows/voice-live-e2e.yml
bunx @biomejs/biome check packages/app-core/scripts/voice-attribution-smoke.ts \
  plugins/plugin-local-inference/src/services/voice/speaker/attribution-pipeline.ts \
  plugins/plugin-local-inference/src/services/voice/speaker/attribution-pipeline.test.ts
bun run --cwd plugins/plugin-local-inference typecheck
bun run --cwd packages/ui typecheck
bun run --cwd packages/app-core typecheck
bun run --cwd plugins/plugin-local-inference vitest run \
  src/services/voice/speaker/attribution-pipeline.test.ts \
  src/services/voice/engine-bridge-transcript-join.test.ts \
  src/services/voice/self-voice-imprint.test.ts \
  src/services/voice/engine-bridge.test.ts \
  src/services/voice/audio-frame-consumer.test.ts \
  __tests__/voice-entity-binding.test.ts
bun run --cwd packages/ui vitest run src/voice/jni-voice-pipeline.test.ts
bun run verify
```

All commands above passed.
