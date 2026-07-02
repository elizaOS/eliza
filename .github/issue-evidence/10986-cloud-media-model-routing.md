# #10986 Cloud Media Model Routing Evidence

## Change

- Removed agent-side Eliza Cloud video/audio fetch providers that posted to nonexistent `/media/video/generate` and `/media/audio/generate` endpoints.
- Cloud-selected video now routes through `runtime.useModel(ModelType.VIDEO)`.
- Cloud-selected music now routes through `runtime.useModel(ModelType.AUDIO)` and `plugin-elizacloud` calls the real `/api/v1/generate-music` SDK route.
- Cloud-selected speech routes through existing `ModelType.TEXT_TO_SPEECH`.
- Direct own-key providers remain direct (`fal`, `openai`, `google`, `suno`, `elevenlabs`).
- Cloud SFX fails clearly because Cloud only exposes music/TTS here; use a direct SFX provider.
- `AudioProcessingParams` and `VideoProcessingParams` were widened additively for generation fields.

## Verification

```bash
rg -n "media/video/generate|media/audio/generate|ElizaCloud(Video|Audio)Provider|createCloudAudioProvider" packages/agent plugins/plugin-elizacloud packages/cloud/api -g '*.ts' -g '*.d.ts'
```

Result: no matches.

```bash
bunx biome check packages/agent/src/providers/media-provider.ts packages/agent/src/providers/media-provider.test.ts packages/agent/src/services/media-generation.ts packages/agent/src/services/media-generation.test.ts packages/core/src/types/model.ts plugins/plugin-elizacloud/src/index.ts plugins/plugin-elizacloud/src/models/index.ts plugins/plugin-elizacloud/src/models/media.ts plugins/plugin-elizacloud/__tests__/cloud-media-generation.test.ts
```

Result: passed (`Checked 6 files`).

```bash
bunx vitest run --config vitest.config.ts src/providers/media-provider.test.ts src/services/media-generation.test.ts
```

Run from `packages/agent`. Result: passed (`2 passed`, `22 tests`).

```bash
bunx vitest run --config vitest.config.ts __tests__/cloud-media-generation.test.ts
```

Run from `plugins/plugin-elizacloud`. Result: passed (`1 passed`, `3 tests`).

```bash
bun run --cwd plugins/plugin-elizacloud typecheck
bun run --cwd packages/core typecheck
```

Result: both passed.

## Known Current-Base Typecheck Drift

```bash
bun run --cwd packages/agent typecheck
```

Result: failed on unrelated current-base command catalog / plugin export drift and missing `@elizaos/cloud-routing` declarations in wallet plugin imports. The rerun no longer reports media-routing or `plugin-elizacloud` handler type errors.

## Live Cloud Evidence

N/A for this code PR: live Cloud video/music calls require valid Cloud credentials and paid generation credits. The new plugin tests assert the SDK methods and payloads for the real generated routes (`postApiV1GenerateVideo`, `postApiV1GenerateMusic`) without hitting dead endpoints.
