# Bench server Cerebras 404 + scenario-runner embedding 401 fix — 2026-05-11

Wave W4-B (retry). Closes out the two bench-side environment noise items
W2-9 flagged in `docs/audits/lifeops-2026-05-11/rebaseline-report.md`.

## Bug A — `AI_APICallError: Not Found` from Cerebras

### Status: already fixed upstream

The W1-3 baseline (`docs/audits/lifeops-2026-05-11/baseline-runs.md`) saw
the eliza HTTP bench server emit `AI_APICallError: Not Found` from Cerebras
on every turn, then fall back to "Something went wrong on my end. Please
try again." The reproducer was `ELIZA_BENCH_LIMIT=1 LIFEOPS_USE_MOCKOON=1
ELIZA_BENCH_AGENT=eliza bun run lifeops:full`.

### Root cause

The OpenAI plugin's text models were going to the OpenAI Responses API
(`/v1/responses`) instead of the Chat Completions API
(`/v1/chat/completions`). Cerebras only exposes the Chat Completions
endpoint, so every `useModel(TEXT_LARGE, ...)` returned HTTP 404. The
planner's failure path swallowed the error and emitted the generic
"Something went wrong" template as a `REPLY`, which LifeOpsBench scores
as zero tool calls and the scenario lands at 0.000.

Wire path:

```
useModel(TEXT_LARGE, ...) →
  plugin-openai TEXT_LARGE handler (plugins/plugin-openai/models/text.ts) →
  generateText({ model, ... }, ai-sdk) →
  @ai-sdk/openai → POST {baseURL}/{path}
```

The decisive switch is `openai.chat(modelName)` vs
`openai.languageModel(modelName)` / `openai.responses(modelName)`:

| call              | wire path                          |
|-------------------|------------------------------------|
| `openai.chat()`   | `POST /chat/completions`           |
| `openai.responses()` | `POST /responses` (OpenAI-only) |

Confirmed in
`node_modules/.bun/@ai-sdk+openai@3.0.53+3c5d820c62823f0b/node_modules/@ai-sdk/openai/dist/index.js`:

```
        path: "/chat/completions",
        path: "/chat/completions",
// src/responses/openai-responses-language-model.ts
// src/responses/convert-openai-responses-usage.ts
// src/responses/convert-to-openai-responses-input.ts
```

### Fix that already landed (this audit just verifies)

`plugins/plugin-openai/models/text.ts:827` (every TEXT_* handler funnels
through `generateTextByModelType`):

```ts
// Use chat() instead of languageModel() to use the Chat Completions API
// which has better compatibility than the Responses API
const model = openai.chat(modelName);
```

Combined with the bench server's auto-wire in
`packages/app-core/src/benchmark/server.ts:85-125`:

```ts
function autoWireCerebras(): void {
  // ... when CEREBRAS_API_KEY is set and no OpenAI key/url is set:
  process.env.OPENAI_BASE_URL = "https://api.cerebras.ai/v1";
  process.env.OPENAI_API_KEY = cerebrasKey;
  process.env.ELIZA_PROVIDER = "cerebras";
  // Pin both model tiers to gpt-oss-120b.
  process.env.OPENAI_LARGE_MODEL = "gpt-oss-120b";
  process.env.OPENAI_SMALL_MODEL = "gpt-oss-120b";
  // ...
}
```

Result: every TEXT_LARGE / TEXT_SMALL call hits `https://api.cerebras.ai/v1/chat/completions`
with `model: gpt-oss-120b`, which is the only endpoint Cerebras serves.

### Verification (no more 404)

Most recent multi-agent eliza Python bench
(`~/.eliza/runs/lifeops/lifeops-multiagent-1778549597914/eliza/lifeops_gpt-oss-120b_20260511_183511.json`):

- `pass_at_1: 0.0` (still scoring partials)
- `mean_score_per_domain: {'calendar': 0.30000000000000004}`
- `smoke_static_calendar_01: state_match=False, score=0.30/1.0, err=`
- No `AI_APICallError`, no `Not Found`, no `404` in the bench server stderr
  log (`/var/folders/.../T/eliza-bench-server-3939-42c1o8ba.stderr.log`
  is zero-byte).

The 5-scenario run earlier the same hour
(`lifeops-multiagent-1778549433787/eliza/lifeops_gpt-oss-120b_20260511_183813.json`)
shows all 5 scenarios scoring `0.30`–`0.80` with two `state_match=True`,
versus W1-3 baseline `lifeops-eliza-baseline-1778515576/.../...093747.json`
which had 25/25 at 0.00.

Per-scenario tool calls captured in
`/var/folders/.../T/eliza-bench-server-3939-42c1o8ba.stdout.log`:

```
[BENCHMARK_ACTION] params: {"tool_name":"CALENDAR_CREATE_EVENT", ...}
[BENCHMARK_ACTION] params: {"tool_name":"CALENDAR", "subaction":"create_event", ...}
[BENCHMARK_ACTION] params: {"tool_name":"CALENDAR_UPDATE_EVENT", ...}
[BENCHMARK_ACTION] params: {"tool_name":"CALENDAR_SEARCH_EVENTS", ...}
```

i.e. the planner is now emitting structured tool calls, not the
"Something went wrong" REPLY template.

## Bug B — Embedding 401 spam from HuggingFace

### Status: silenced in the scenario-runner path (bench server path was
already silenced)

W2-9 noted repeated `Failed to download: 401` errors against
`huggingface.co/elizaos/eliza-1-lite-0_6b` on every turn:

```
Warn Model download attempt failed (description=LFS URL with GGUF suffix, error=Failed to download: 401, ...)
Warn Model download attempt failed (description=LFS URL without GGUF suffix, error=Failed to download: 401, ...)
Warn Model download attempt failed (description=Standard URL with GGUF suffix, error=Failed to download: 401, ...)
Warn Model download attempt failed (description=Standard URL without GGUF suffix, error=Failed to download: 401, ...)
Error Model download failed (error=Failed to download: 401, ...)
Error Embedding model download failed (error=Failed to download: 401, modelType=TEXT_EMBEDDING, ...)
Error Error in TEXT_EMBEDDING handler (error=Failed to download: 401)
Error [PLUGIN:BASIC-CAPABILITIES:SERVICE:EMBEDDING] Failed to generate embedding (...)
```

Repeated 4× per turn × every memory write = log torrent.

### Root cause

Two distinct runtime paths register `@elizaos/plugin-local-embedding`:

1. **`packages/app-core/src/benchmark/server.ts` (bench server)** — already
   handled in W1-9+: the server skips `@elizaos/plugin-local-embedding`
   when `ELIZA_BENCH_SKIP_EMBEDDING != "0"` (default ON in bench mode)
   and registers a zero-vector `TEXT_EMBEDDING` stub at priority 100.
   No 401s in this path.
2. **`packages/scenario-runner/src/runtime-factory.ts` (legacy JS
   scenario-runner)** — unconditionally registered
   `@elizaos/plugin-local-embedding`, so every scenario boot lazily
   downloaded the gated GGUF on first `TEXT_EMBEDDING` call, failed
   with 401, reset `embeddingInitializingPromise = null`, and retried
   on the next turn. Every retry produced a 4-line 401 burst plus
   error lines.

### Fix

`packages/scenario-runner/src/runtime-factory.ts` — mirror the bench
server's pattern: default to a zero-vector `TEXT_EMBEDDING` stub at
priority 100 (higher than `@elizaos/plugin-local-embedding`'s priority
10), gated by the same `ELIZA_BENCH_SKIP_EMBEDDING` env var (default
ON). Operators who actually want local embeddings opt back in with
`ELIZA_BENCH_SKIP_EMBEDDING=0`.

```ts
const skipEmbeddingPlugin =
  (process.env.ELIZA_BENCH_SKIP_EMBEDDING ?? "1") !== "0";
if (skipEmbeddingPlugin) {
  const EMBEDDING_DIMENSIONS = 1024;
  const stubEmbeddingPlugin: Plugin = {
    name: "scenario-runner-stub-embedding",
    description: "...",
    priority: 100,
    models: {
      TEXT_EMBEDDING: async () =>
        new Array<number>(EMBEDDING_DIMENSIONS).fill(0),
    },
  };
  await runtime.registerPlugin(stubEmbeddingPlugin);
  logger.info(
    `[scenario-runner] Registered zero-vector TEXT_EMBEDDING stub (dim=${EMBEDDING_DIMENSIONS}); ` +
      "set ELIZA_BENCH_SKIP_EMBEDDING=0 to use @elizaos/plugin-local-embedding instead.",
  );
} else {
  // existing local-embedding load
}
```

### Verification

`ELIZA_BENCH_LIMIT=1 LIFEOPS_USE_MOCKOON=1 bun --bun packages/scenario-runner/src/cli.ts run plugins/app-lifeops/test/scenarios`
(2026-05-11):

```
Info [scenario-runner] Registered zero-vector TEXT_EMBEDDING stub (dim=1024); set ELIZA_BENCH_SKIP_EMBEDDING=0 to use @elizaos/plugin-local-embedding instead.
```

No `401`, no `Failed to download`, no `Model download attempt failed`
in the scenario-runner log. Scenario pass/fail breakdown unchanged
(failures are unrelated planner/tool-selection issues already tracked
in `docs/audits/lifeops-2026-05-11/eliza-tool-call-fix.md` followups).

## Files changed

- `packages/scenario-runner/src/runtime-factory.ts` — replaced
  unconditional `@elizaos/plugin-local-embedding` registration with the
  zero-vector stub pattern from the bench server, gated by
  `ELIZA_BENCH_SKIP_EMBEDDING` (default ON).
- `docs/audits/lifeops-2026-05-11/bench-server-cerebras-404-fix.md` —
  this file.

## Out of scope

- Bug A. The Cerebras 404 was already fixed by:
  - `openai.chat()` routing in `plugins/plugin-openai/models/text.ts`,
  - `autoWireCerebras()` in `packages/app-core/src/benchmark/server.ts`,
  - W1-9's `isBenchmarkForcingToolCall` planner-gate flip.
  Per the brief's hard constraint ("DO NOT modify W1-9's
  `isBenchmarkForcingToolCall`"), the verification step is what's
  delivered — no code change needed in this wave.
- `plugin-local-embedding`'s internal retry loop. Operators who
  opt back in with `ELIZA_BENCH_SKIP_EMBEDDING=0` still get the same
  401 burst, but that's the intentional opt-in surface. Caching the
  401 once-per-session would change the public behavior of the plugin
  outside benchmark mode, which is W4-C/W4-G territory rather than W4-B.
