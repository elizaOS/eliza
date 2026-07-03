# Issue #11741 - Audio and SFX Provider Registry Evidence

## What Changed

- Added `packages/cloud/shared/src/lib/providers/audio` with provider registry selection for music and sound effects.
- Moved FAL MiniMax Music request mapping, queue polling, response normalization, and credential checks out of the `/api/v1/generate-music` route.
- Added ElevenLabs sound-effects generation and FAL Stable Audio generation behind the same audio provider contract.
- Added `/api/v1/generate-sfx` with SFX pricing, credit reservation/refund handling, provider selection, and generation persistence.

## Manual Review

- Reviewed `packages/cloud/api/v1/generate-music/route.ts` and confirmed it delegates provider-specific work to the shared audio provider registry.
- Reviewed `packages/cloud/api/v1/generate-sfx/route.ts` and confirmed credit reservations are refunded when validation or provider execution fails.
- Reviewed `packages/cloud/shared/src/lib/providers/audio/elevenlabs-audio-generation.ts` and confirmed the binary audio response is persisted through the configured storage adapter.
- Reviewed `packages/cloud/shared/src/lib/providers/audio/fal-audio-generation.ts` and confirmed both object-shaped FAL queue results and direct Stable Audio string URL results are normalized before returning to the API route.
- Reviewed `packages/cloud/shared/src/lib/services/ai-pricing/providers/sfx.ts` and confirmed the Stable Audio fallback uses the current FAL public price of `$0.20` per audio generation.

## Validation

- `bun run --cwd packages/core build`
- `bun run --cwd packages/security build`
- `bun test --isolate --reporter=dots --coverage-reporter=lcov packages/cloud/shared/src/lib/providers/audio/fal-audio-generation.test.ts packages/cloud/shared/src/lib/providers/audio/elevenlabs-audio-generation.test.ts packages/cloud/shared/src/lib/services/media-model-roster.test.ts packages/cloud/api/__tests__/generate-sfx-route.test.ts`
  - Result: 21 passing tests, 0 failures.
- `bun run --cwd packages/cloud/shared typecheck`
- `bun run --cwd packages/cloud/api typecheck`
- `bunx @biomejs/biome check packages/cloud/api/__tests__/generate-sfx-route.test.ts packages/cloud/api/v1/generate-image/route.ts packages/cloud/api/v1/generate-music/route.ts packages/cloud/api/v1/generate-sfx/route.ts packages/cloud/shared/src/lib/providers/audio/fal-audio-generation.ts packages/cloud/shared/src/lib/providers/audio/fal-audio-generation.test.ts packages/cloud/shared/src/lib/providers/audio/elevenlabs-audio-generation.ts packages/cloud/shared/src/lib/providers/audio/elevenlabs-audio-generation.test.ts packages/cloud/shared/src/lib/providers/audio/registry.ts packages/cloud/shared/src/lib/providers/audio/types.ts packages/cloud/shared/src/lib/providers/fal-queue.ts packages/cloud/shared/src/lib/providers/image/fal-image-generation.ts packages/cloud/shared/src/lib/services/ai-pricing/providers/sfx.ts packages/cloud/shared/src/lib/services/media-model-roster.ts packages/cloud/shared/src/lib/services/media-model-roster.test.ts`
- `bun run verify`

## N/A

- Live generated audio/SFX artifacts: N/A - tracked by #11745 because live provider credentials and spend are required.
- UI screenshots/video: N/A - this is a cloud API/shared provider change with no dashboard UI changes.
- Live LLM trajectories: N/A - no agent prompt/model behavior changed.
