# gemma-4-31b context limit — definitive (256k is not served by Cerebras)

The cutover brief assumed gemma-4-31b "comes with ~256k" context. This is the
model card's figure, **not** what Cerebras serves. Verified against the live
paid-tier API on 2026-07-02.

## Probes (raw `POST https://api.cerebras.ai/v1/chat/completions`, key redacted)

| test | result |
| --- | --- |
| 140k-token prompt (`alpha `×140000) | HTTP 400 `context_length_exceeded`: **"Current length is 140014 while limit is 131072"** |
| add request param `context_length: 262144` | HTTP 400 `wrong_api_format`: **"property 'context_length' is unsupported"** |
| add request param `max_context_length: 262144` | rejected (unsupported) |
| `GET /v1/models/gemma-4-31b` | returns no context metadata |

Cross-check: `inference-docs.cerebras.ai/models/gemma-4-31b` — **65k free tier /
131k paid tier**, 40k max output (paid).

## Conclusion

**131072 tokens is the hard, non-extensible ceiling** for gemma-4-31b on
Cerebras. There is no parameter, flag, tier, or endpoint that reaches 256k —
Cerebras rejects any prompt over 131072 and rejects the `context_length`
override outright. Building a 256k-token prompt would produce a hard 400 from
the provider on every call, so **capping context handling at 131072 is the
correct behavior, not a shortfall.** "Increase to the 256k gemma comes with" is
not achievable against Cerebras serving; the maximum achievable is wired.

## Where 131072 is now pinned (this change)

- `packages/core/src/features/trajectories/pricing.ts` — `MODEL_CONTEXT_WINDOW_TOKENS["gemma-4-31b"] = 131_072` (drives `buildModelInputBudget`; was the round 131_000).
- `packages/cloud/shared/src/lib/models/catalog.ts` — both gemma catalog entries → 131072.
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/model_tiers.py` — large tier → 131_072.
- `packages/benchmarks/lib/src/model-tiers.ts` — already 131_072 (from the cutover).

The compaction budget reserves 20% headroom off this window, so prompts are
kept safely under the provider limit.
