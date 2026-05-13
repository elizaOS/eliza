# Fused Attention Op Contract

This note defines the runtime contract for the optional fused attention path:

```text
QJL-compressed K score -> online softmax -> quantized V mix
```

The fused op is an optimization layered on top of the required Eliza-1 cache
kernels. It is not a release-required manifest kernel by itself until every
publish target has runtime-ready graph-dispatch evidence for the fused route.

## Required Semantics

- The graph route must execute `GGML_OP_FUSED_ATTN_QJL_TBQ` or a documented
  fused equivalent.
- The score vector must not be materialized as an intermediate tensor.
- Output must match the reference composition:
  `qjl_score -> causal/non-causal softmax -> TBQ/Polar V decode -> weighted sum`.
- GQA mapping must use `h_kv = h_q / (n_heads / n_kv_heads)`.
- Causal mode must mask tokens after the query position before the online
  softmax accumulator is updated.
- The backend must fail closed if required cache metadata, block layout, or
  kernel capability evidence is absent.

## Verification Gate

Runtime-ready status requires all of the following:

- fixture parity on `verify/fixtures/fused_attn_qjl_tbq.json` or the matching
  fused fixture for the value-cache type,
- built-fork graph-dispatch smoke proving the real llama.cpp graph selects the
  shipped fused kernel,
- numeric `maxDiff` recorded in the backend runtime-dispatch evidence file,
- a Makefile smoke target that can reproduce the evidence.

The current Vulkan evidence satisfies this for `GGML_OP_FUSED_ATTN_QJL_TBQ`.
Metal standalone fused kernels are verified separately, but Metal fused graph
dispatch remains a distinct gate.
