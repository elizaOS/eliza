# #10199 — gpt-oss-120b standard-benchmark rerun + harness truncation fix

Model: **gpt-oss-120b** · Provider: **cerebras** (`https://api.cerebras.ai/v1`)
Base SHA: `617621c0131` · Date: 2026-07-01 · Reviewer: read the trajectories/failures by hand (below).

## Harness bug found + fixed (the "validate the harness itself" AC)

gpt-oss is a **reasoning** model: it spends completion tokens on hidden reasoning
before the visible answer. The MMLU (`max_tokens=256`) and GSM8K
(`max_tokens=384`) adapters truncated mid-reasoning, so the visible answer was
**empty / missing the `#### <int>` line**, scored as wrong — silently depressing
a real score. This is a scorer/partial-output-handling defect, not a model result.

| Benchmark | before (old default) | after (reasoning-safe) | cause |
|---|---|---|---|
| MMLU (25, abstract_algebra) | **0.48**, 11/25 empty visible outputs | **0.92**, 0 empty | `max_tokens` 256 → 2048 |
| GSM8K (25) | **0.72**, format_ok 0.72 | **1.00** | `max_tokens` 384 → 2048 |
| HumanEval (15) | **1.00** (default 2048 already ok) | **1.00** | unaffected |

Same items, same seed — the deltas are pure truncation, confirmed by inspecting
the `failures` (all `"predicted": "<empty>"`, `"empty_visible_output": true`)
and re-running the identical set with a larger budget.

## Fix

- `benchmarks/standard/mmlu.py`: `DEFAULT_MAX_TOKENS` 256 → 2048; a loud
  **truncation warning** + `empty_output_rate` in `raw_json` so a partially-empty
  run is never mistaken for a real low score (a single MCQ letter costs ~1 token,
  so non-reasoning models are unaffected; only reasoning headroom changes).
- `benchmarks/standard/gsm8k.py`: runner + CLI `--max-tokens` default 384 → 2048.

## Verification

Deterministic:
```
$ python -m pytest benchmarks/standard/tests/test_mmlu.py benchmarks/standard/tests/test_gsm8k.py
26 passed   # incl. a new partial-empty test that asserts the truncation warning + rate
```
Live (real gpt-oss-120b on Cerebras), with the NEW defaults (no flags):
```
MMLU  --limit 25 → score 0.92, empty_outputs 0, empty_output_rate 0.0
GSM8K --limit 25 → score 1.00
HumanEval --limit 15 → pass@1 1.00
```

## Notes / N/A
- Raw result JSON + trajectories are **generated and not committed** (per the
  benchmarks convention + the new `verify-artifacts` guard from #10664); this
  reviewed scorecard is the committed artifact.
- Scope: the graded rerun covers the standard academic subset (MMLU/GSM8K/HumanEval)
  and fixes the harness truncation bug for reasoning models. The full 43-benchmark
  registry rerun + HITL multi-Codex harness remain the larger #10199 scope.
