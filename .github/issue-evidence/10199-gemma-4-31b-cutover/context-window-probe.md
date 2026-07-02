# gemma-4-31b context-window probe (live, Cerebras API)

Date: 2026-07-02 (UTC). Probed via raw `POST https://api.cerebras.ai/v1/chat/completions`
with `Authorization: Bearer $CEREBRAS_API_KEY` (key redacted; paid-tier key).

Goal: establish the REAL enforceable context ceiling for `gemma-4-31b` before
encoding it in `MODEL_CONTEXT_WINDOW_TOKENS` / benchmark tier configs. The
cutover brief assumed "~256k"; the provider enforces less.

## Method

Prompts of N repetitions of the word `alpha ` (≈1 token each) + a short suffix,
`max_tokens: 5`, model `gemma-4-31b`.

## Results

| prompt size (~tokens) | outcome |
| --- | --- |
| 120,020 (usage.total_tokens reported) | HTTP 200, completion returned |
| 200,015 | HTTP 400 `context_length_exceeded`: "Current length is 200015 while limit is 131000" |
| 250,015 | HTTP 400 `context_length_exceeded`: "limit is 131000" |
| 262,015 | HTTP 400 `context_length_exceeded`: "limit is 131000" |
| 270,000 | HTTP 429 `token_quota_exceeded` (TPM window exhausted by prior probes) |

Verbatim rejection body (200k probe):

```json
{"message":"Please reduce the length of the messages or completion. Current length is 200015 while limit is 131000","type":"invalid_request_error","param":"messages","code":"context_length_exceeded","id":""}
```

## Cross-check against provider docs

`inference-docs.cerebras.ai/models/gemma-4-31b` (fetched 2026-07-02):
context window **65k tokens (free tier) / 131k tokens (paid tier)**, max output
**32k (free) / 40k (paid)**. Features: image inputs, reasoning (off by default,
enabled via `reasoning_effort`), streaming, structured outputs, tool calling,
parallel tool calling, prompt caching.

## Feature probes (live, same session)

- `reasoning_effort: "low"` → HTTP 200, response includes a `reasoning` field
  (reasoning is opt-in for gemma-4-31b, unlike gpt-oss-120b's default-on).
- `response_format: {type: "json_schema", strict: true}` → HTTP 200, exact
  schema-conforming JSON.
- Tool calling with one function → HTTP 200, well-formed `tool_calls` entry.
- `max_tokens: 50000` accepted on a short prompt (server clamps internally).

## Conclusion

The enforceable ceiling is **131,000 tokens total (prompt + completion)** on the
paid tier — the "256k-ish" assumption does not hold on Cerebras serving.
`packages/core/src/features/trajectories/pricing.ts` already pins
`MODEL_CONTEXT_WINDOW_TOKENS["gemma-4-31b"] = 131_000` (landed with #10695);
this cutover aligns the benchmark eval tier (`packages/benchmarks/lib/src/model-tiers.ts`,
`contextWindow: 131_000`) and the Python lifeops-bench large tier to the same
verified number. Long-context benchmark budgets must stay under 131k.
