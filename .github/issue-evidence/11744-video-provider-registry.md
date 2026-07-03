# Issue #11744 - Video Provider Registry Evidence

## What Changed

- Moved FAL video generation request mapping, response normalization, credential checks, and invocation behind `packages/cloud/shared/src/lib/providers/video`.
- Updated `/api/v1/generate-video` to select a video provider by pricing catalog `billingSource` while preserving existing FAL model IDs and response shape.
- Kept credit reservation/refund behavior in the route and added coverage for unsupported model rejection plus missing provider credentials.

## Manual Review

- Reviewed `packages/cloud/api/v1/generate-video/route.ts` and confirmed FAL-specific request construction no longer lives inline in the route.
- Reviewed `packages/cloud/shared/src/lib/providers/video/fal-video-generation.ts` and confirmed the moved normalizer still accepts both `video` and `videos[0]` provider payloads.
- Reviewed `bun.lock`; the only retained lockfile delta is adding `@fal-ai/client` to the `packages/cloud/shared` workspace dependency block.

## Validation

- `bun run --cwd packages/core build`
- `bun run --cwd packages/security build`
- `bun test packages/cloud/shared/src/lib/providers/video/fal-video-generation.test.ts`
- `bun test packages/cloud/api/__tests__/generate-video-credit-leak.test.ts`
- `bun run --cwd packages/cloud/shared typecheck`
- `bun run --cwd packages/cloud/api typecheck`
- `bunx @biomejs/biome check --write packages/cloud/api/__tests__/generate-video-credit-leak.test.ts packages/cloud/api/v1/generate-video/route.ts packages/cloud/shared/src/lib/providers/video/fal-video-generation.ts packages/cloud/shared/src/lib/providers/video/fal-video-generation.test.ts packages/cloud/shared/src/lib/providers/video/registry.ts packages/cloud/shared/src/lib/providers/video/types.ts packages/cloud/shared/package.json`

## N/A

- Live FAL provider calls and generated video artifacts: N/A - explicitly out of scope for #11744 and tracked by the live-evidence child issue.
- UI screenshots/video: N/A - this is a cloud API/shared provider refactor with no dashboard UI changes.
- Live LLM trajectories: N/A - no agent prompt/model behavior changed.
