# 10819 Cloud Image Generation Evidence

Issue: https://github.com/elizaOS/eliza/issues/10819

## What Was Verified

- Cloud-selected image generation in `AgentMediaGenerationService` routes through the registered `ModelType.IMAGE` handler instead of the removed direct Cloud image provider.
- Own-key image generation still routes to the configured direct provider instead of the Cloud image model.
- The stale agent-side `/media/image/generate` fetch path is removed from tracked source.
- Direct own-key image/video/audio providers remain covered by the existing provider tests.
- Missing Cloud image model registration fails with a clear "requires Eliza Cloud or a direct image provider" error.

## Commands Run

```bash
bun install
bunx biome check --write packages/agent/src/services/media-generation.ts packages/agent/src/services/media-generation.test.ts packages/agent/src/providers/media-provider.ts packages/agent/src/providers/media-provider.test.ts
bunx vitest run --config packages/agent/vitest.config.ts packages/agent/src/providers/media-provider.test.ts packages/agent/src/services/media-generation.test.ts --coverage.enabled=false
bunx vitest run --config packages/core/vitest.config.ts packages/core/src/features/advanced-capabilities/actions/generateMedia.test.ts --coverage.enabled=false
rg -n "/media/image/generate|ElizaCloudImageProvider" packages/agent/src packages/core/src plugins/plugin-elizacloud/src packages/cloud/sdk/src packages/cloud/api/v1 || true
bun run --cwd packages/agent typecheck
bun run verify
```

## Results Reviewed

- Post-rebase `bun install`: completed with no lockfile changes.
- Agent focused Vitest: 2 test files passed, 17 tests passed.
- Core action Vitest: 1 test file passed, 8 tests passed.
- Source grep: no stale `/media/image/generate`, `media/image/generate`, or `ElizaCloudImageProvider` matches in tracked source paths.
- `packages/agent` typecheck: blocked by pre-existing command-plugin export/type errors outside this change (`commands-routes`, `plugin-discord/catalog-commands`, `plugin-task-coordinator/orchestrator-command`). The new media-generation test type error found on the first run was fixed and did not recur.
- Root `bun run verify`: blocked before package checks by the repo-wide type-safety ratchet (`?? 0` count 382 > baseline 380). The branch diff adds no `?? 0`, `as unknown as`, `: any`, or ts-ignore/expect-error patterns.

## Evidence N/A / Deferred

- UI screenshots/video: N/A, no UI changed.
- Frontend logs/network: N/A, no frontend request path changed.
- Live Cloud generation trajectory: not captured in this local pass because the shell has no `ELIZAOS_CLOUD_API_KEY`, `ANTHROPIC_API_KEY`, `CEREBRAS_API_KEY`, or `OPENAI_API_KEY` configured. The PR includes deterministic coverage proving the agent path now delegates to the existing plugin-elizacloud `ModelType.IMAGE` handler, which already uses `ElizaCloudClient.generateImage()`.
