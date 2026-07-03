# Issue #11742 - Media Model Roster Evidence

## What Changed

- Added `packages/cloud/shared/src/lib/services/media-model-roster.ts` as the checked-in FAL/Google media model roster.
- Marked currently routed families as `wired` and every non-routed candidate as `deferred` with an explicit rationale.
- Added `media-model-roster.test.ts` to prove source/rationale completeness, ensure every wired model id remains indexed in the supported pricing definitions, and ensure every supported image/video/music pricing model is represented in the roster.

## Reviewed Sources

- FAL Veo 3 model page: `https://fal.ai/models/fal-ai/veo3`
- FAL Kling exploration page: `https://fal.ai/explore/kling`
- FAL Recraft V3 model page: `https://fal.ai/models/fal-ai/recraft/v3/text-to-image`
- FAL Ideogram V3 model page: `https://fal.ai/models/fal-ai/ideogram/v3`
- FAL Stable Audio 2.5 model page: `https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio`
- ElevenLabs sound effects API page: `https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert`
- FAL pricing page: `https://fal.ai/pricing`
- Google Gemini API model roster: `https://ai.google.dev/gemini-api/docs/models`
- Google DeepMind Imagen page: `https://deepmind.google/models/imagen/`
- Atlas Cloud Google provider page: `https://www.atlascloud.ai/providers/google`

## Roster Decisions

- Wired: FAL FLUX/Recraft/Ideogram image, Atlas-hosted GPT Image 2 / Seedream / Google Nano Banana / Qwen image generation, FAL Veo/Kling/Hailuo/Wan/PixVerse/Seedance video, FAL MiniMax Music, ElevenLabs Music, Suno-compatible music, FAL Stable Audio SFX, and ElevenLabs sound effects.
- Deferred: Luma, Runway, MMAudio, direct Google Imagen 4, direct Google Veo, and direct Gemini Omni/media routes.

## Validation

- `bun run install:light`
- `node packages/shared/scripts/generate-keywords.mjs --target ts`
- `node packages/shared/scripts/generate-keywords.mjs --target js`
- `bun test packages/cloud/shared/src/lib/services/media-model-roster.test.ts`
- `bun run --cwd packages/cloud/shared typecheck`
- `bun run --cwd packages/cloud/shared lint`
- `bunx @biomejs/biome check --write packages/cloud/shared/src/lib/services/media-model-roster.ts packages/cloud/shared/src/lib/services/media-model-roster.test.ts`
- `git diff --check`

## N/A

- Live media generation: N/A - this issue is the roster/catalog decision slice; live generated artifacts are tracked separately by #11745.
- UI screenshots/video: N/A - no UI changed.
- Live LLM trajectories: N/A - no agent prompt/model behavior changed.
