# Issue #11265 evidence: OpenAI streamed usage + trajectory response

Branch: `fix/11265-openai-stream-usage-final`
Base: `origin/develop@8bed05c1718`
Date: 2026-07-02

## What changed

- `plugins/plugin-openai/models/text.ts` now records live streaming telemetry after
  the returned `textStream` is consumed, not at stream construction time.
- The stream generator accumulates emitted chunks, resolves `usage` and
  `finishReason` in `finally`, emits `MODEL_USED`, and logs the LLM trajectory
  with the real streamed response text.
- Regression coverage asserts the trajectory is not logged before stream
  consumption, then proves `MODEL_USED` and trajectory response/usage are present
  after consumption.

## Focused verification

```bash
bun install --frozen-lockfile
bun run --cwd packages/core prebuild
bun run --cwd packages/core build:node
bun run --cwd plugins/plugin-openai test -- __tests__/native-plumbing.shape.test.ts --testTimeout 60000
bun run --cwd plugins/plugin-openai test
bun run --cwd plugins/plugin-openai typecheck
bun run --cwd plugins/plugin-openai lint:check
bun run --cwd plugins/plugin-openai build
git diff --check
```

Results:

- Focused native plumbing test: 1 file, 13 tests passed.
- Full `plugin-openai` unit suite: 7 files passed, 1 skipped; 80 tests passed, 3 skipped.
- `plugin-openai` typecheck: passed.
- `plugin-openai` lint: passed.
- `plugin-openai` build: passed.
- `git diff --check`: passed.

## Live provider proof

No `OPENAI_API_KEY` was present in the shell, but `CEREBRAS_API_KEY` was
available. Since `plugin-openai` supports Cerebras through its OpenAI-compatible
endpoint, I ran a targeted live stream with:

```bash
OPENAI_API_KEY="$CEREBRAS_API_KEY" \
OPENAI_BASE_URL=https://api.cerebras.ai/v1 \
ELIZA_PROVIDER=cerebras \
bun -e '<script imports handleTextSmall, consumes textStream, captures runtime events + trajectory log>'
```

Manually reviewed output:

```json
{
  "streamed": "live stream telemetry ok",
  "fullText": "live stream telemetry ok",
  "usage": {
    "promptTokens": 30,
    "completionTokens": 5,
    "totalTokens": 35,
    "cachedPromptTokens": 0,
    "cacheReadInputTokens": 0
  },
  "finishReason": "stop",
  "modelUsedEvents": [
    {
      "type": "TEXT_SMALL",
      "source": "openai",
      "provider": "openai",
      "tokens": {
        "prompt": 30,
        "completion": 5,
        "total": 35,
        "cached": 0
      }
    }
  ],
  "trajectoryCalls": [
    {
      "stepId": "issue-11265-live",
      "actionType": "ai.streamText",
      "response": "live stream telemetry ok",
      "finishReason": "stop",
      "promptTokens": 30,
      "completionTokens": 5,
      "latencyMs": 192
    }
  ]
}
```

This proves the real streamed provider path no longer records an empty
trajectory response and no longer drops `MODEL_USED`.

## Additional note

I also attempted the pre-existing `cloud-streaming.live.test.ts` against the
Cerebras-backed OpenAI-compatible endpoint. It reached the live provider and
streamed, but failed its old wall-clock assertion because all chunks arrived in
the same millisecond (`distinctTimes` was 1). That failure is orthogonal to
#11265; the targeted live proof above validates this issue's telemetry behavior.

## Repo-level verify

`bun run verify` still fails before typecheck/lint at the current `develop`
type-safety ratchet baseline:

```text
[type-safety-ratchet] unsafe cast baseline exceeded
  - as unknown as: 80 current > 77 baseline
  - `?? {}` (core/agent/app-core): 379 current > 377 baseline
```

The changed production source does not add either pattern.
