# Issue #11741 - Audio Provider Registry

## Summary

Implemented a shared audio provider registry for cloud content generation and refactored `/api/v1/generate-music` to route through it while preserving existing Fal, ElevenLabs, and Suno behavior.

## Provider Docs Reviewed

- Fal Stable Audio: https://fal.ai/models/fal-ai/stable-audio
- Fal MMAudio V2 text-to-audio: https://fal.ai/models/fal-ai/mmaudio-v2/text-to-audio
- ElevenLabs sound effects: https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert
- ElevenLabs sound effects overview: https://elevenlabs.io/docs/overview/capabilities/sound-effects

## Explicit Deferrals

- `fal-ai/stable-audio`: deferred until a supported catalog/pricing row is wired.
- `fal-ai/mmaudio-v2`: deferred until route inputs and pricing distinguish SFX/video-audio use.
- `elevenlabs/sound-effects`: deferred until a distinct catalog row and request shape are added.

## Validation

- `bun run install:light` - pass
- `bun run --cwd packages/core build` - pass
- `bunx @biomejs/biome check --write packages/cloud/shared/src/lib/providers/audio packages/cloud/api/v1/generate-music/route.ts packages/cloud/api/__tests__/generate-music-audio-registry.test.ts packages/cloud/shared/package.json` - pass
- `bun test packages/cloud/shared/src/lib/providers/audio/audio-generation.test.ts` - pass, 3 tests
- `bun test packages/cloud/api/__tests__/generate-music-audio-registry.test.ts` - pass, 4 tests
- `bun run --cwd packages/cloud/shared typecheck` - pass
- `bun run --cwd packages/cloud/api typecheck` - pass
- `bun run --cwd packages/cloud/shared lint` - pass
- `bun run --cwd packages/cloud/api lint` - pass
- `git diff --check` - pass

## Artifact Review

- Mocked provider route tests cover success, unsupported model validation before credits/provider, provider failure refund, and post-settle persistence failure without refund.
- Live generated audio: N/A - tracked separately by issue #11745.
- Real LLM trajectories: N/A - route/provider plumbing change, no agent prompt/model trajectory changed.
- UI screenshots/video/frontend logs: N/A - no UI surface changed.
