# Issue #11265 - OpenAI live-stream usage + trajectory telemetry

## Scope

Fixes `plugin-openai` live `streamText` chat turns so telemetry is finalized after
the returned `textStream` is consumed instead of when the AI SDK stream object is
created.

## Code paths changed

- `plugins/plugin-openai/models/text.ts`
  - live streaming branch now accumulates emitted chunks
  - awaits usage / finish reason / tool-call companion promises during stream
    finalization
  - emits `MODEL_USED` from real AI SDK usage
  - logs `ai.streamText` trajectory entries with non-empty `response`, usage,
    finish reason, and latency
  - preserves strict trajectory active-step checking before the raw SDK call
  - propagates AI SDK `onError` provider errors after the stream drains
- `plugins/plugin-openai/__tests__/native-plumbing.shape.test.ts`
  - regression coverage for stream telemetry, early-break finalization, and
    provider `onError`
- `plugins/plugin-openai/__tests__/cerebras-spawn-subagent-refusal.live.test.ts`
  - one Biome formatting cleanup required for package `lint:check`

## Real provider evidence

Artifact: `.github/issue-evidence/11265-openai-live-stream-trajectory.json`

Manual review result: good.

Live run details:

- Provider: Cerebras OpenAI-compatible endpoint (`https://api.cerebras.ai/v1`)
- Model: `gpt-oss-120b`
- Path: `handleTextSmall(..., { stream: true })` through
  `plugins/plugin-openai/models/text.ts`
- Stream chunks captured: 16
- `MODEL_USED` events captured: 1
- trajectory `logLlmCall` records captured: 1
- Assertions in artifact:
  - `streamedChunksObserved: true`
  - `modelUsedEventObserved: true`
  - `trajectoryResponseFilled: true`
  - `usageTokensRecorded: true`
  - `assembledMatchesText: true`

Sanitization check: the artifact stores provider, base URL, model, prompt, chunks,
sanitized event payload, and sanitized trajectory fields only. It does not store
the API key or the runtime object.

## Verification

Base synced before PR work:

```bash
git fetch origin
git rebase origin/develop
```

Setup required for the fresh worktree:

```bash
bun install
bun run --cwd packages/core prebuild
bun run --cwd packages/core build:node
```

Focused and package gates:

```bash
bun run --cwd plugins/plugin-openai test -- __tests__/native-plumbing.shape.test.ts --testTimeout 60000
# PASS: 1 file, 15 tests

bun run --cwd plugins/plugin-openai test
# PASS: 7 files passed, 1 skipped; 82 tests passed, 3 skipped

bun run --cwd plugins/plugin-openai typecheck
# PASS

bun run --cwd plugins/plugin-openai lint:check
# PASS

bun run --cwd plugins/plugin-openai build
# PASS
```

Repo-level gate:

```bash
bun run verify
```

Result: fails before typecheck/lint at the existing type-safety ratchet baseline:

- `as unknown as: 80 current > 77 baseline`
- `?? {}` in core/agent/app-core: `379 current > 377 baseline`

This OpenAI patch adds neither pattern.

## UI / media evidence

N/A - this change is server/model-adapter telemetry only. No app UI, audio,
native, mobile, desktop, or media rendering path changed.
