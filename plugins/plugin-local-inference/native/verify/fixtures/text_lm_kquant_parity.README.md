# K-quant LM parity fixtures

Per R8 §5.2, each K-quant level shipped in a published bundle gates on a
parity fixture that compares the quantized model's greedy completion
against the F16 reference for a fixed prompt + seed.

## Fixture filenames

- `text_lm_q3km_parity.json` — Q3_K_M vs F16
- `text_lm_q4km_parity.json` — Q4_K_M vs F16
- `text_lm_q5km_parity.json` — Q5_K_M vs F16
- `text_lm_q6k_parity.json`  — Q6_K vs F16

These files are **not** hand-edited. Regenerate per-tier on hardware day:

```sh
node ../gen_kquant_parity_fixture.mjs \
  --gguf-dir ~/.eliza/local-inference/models/eliza-1-<tier>.bundle/text \
  --prompt "The capital of France is" \
  --out-dir .
```

## Schema

```json
{
  "kernel": "text_lm_kquant_parity",
  "model": "<gguf basename>",
  "quant": "Q4_K_M",
  "prompt": "<fixed prompt>",
  "seed": 1234,
  "n_tokens": 8,
  "reference_quant": "F16",
  "reference_completion": "<F16 greedy completion of n_tokens>",
  "expected_completion": "<quant greedy completion>",
  "tol_token_mismatch": 0,
  "tol_logit_l2": 0.05,
  "generated_at": "<ISO timestamp>",
  "notes": "..."
}
```

## Gate

- `tol_token_mismatch: 0` is currently a hard rule: the first 8 greedy
  tokens of the quant must match the F16 reference exactly. R8 §5.2
  explicitly forbids the "next smaller quant is good enough" fallback —
  if a quant doesn't match the reference, do not ship it.
- `tol_logit_l2` is informational until the full perplexity probe is
  wired (R8 §5.2 future work; not on Wave-2 critical path).

## Why the F16 reference

The K-quant family (Q3_K_M, Q4_K_M, Q5_K_M, Q6_K) is mixed-precision
quantization derived from `llama-quantize` reading an F16 source GGUF.
The publishable evidence that the quant is faithful is its bit-exact
greedy completion against that same F16 reference. Hand-rolled fp32
baselines drift across llama.cpp versions; the F16 source we ship in the
bundle is the immutable witness.

## See also

- `docs/inference/voice-quant-matrix.md` — live coverage table.
- `.swarm/research/R8-quant.md` §5 — verification harness extension
  spec.
- `plugins/plugin-local-inference/native/AGENTS.md` §8 — verification
  gate definition.
