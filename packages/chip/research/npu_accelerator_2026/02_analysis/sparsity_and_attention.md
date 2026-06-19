# Sparsity, attention, and KV-cache acceleration for E1

Date: 2026-05-19

This file synthesizes the sparsity and attention-accelerator literature
against the E1 microarchitecture targets:

- `microarchitecture_targets.engines` includes `sparsity_decode`.
- `numeric_targets.sparse_int4_peak_tops_min: 512` (≈ 3.2x dense INT8 TOPS).
- The current ABI exposes only the scalar `SDOT4_S4_2_4` 2:4 sparse INT4
  primitive (see `docs/arch/npu.md`).

## Why 2:4 N:M is the right starting point

The semi-structured 2:4 sparsity pattern is the only sparsity shape that
already has:

- a peer-reviewed pruning algorithm (`sparsegpt_paper`, `wanda_paper`);
- a learned-mask refinement (`maskllm_paper`);
- production tensor-core support (NVIDIA Ampere onward, AMD CDNA, and
  every recent vendor entry);
- accuracy retention close to dense at 50% sparsity on multi-billion
  parameter LLMs.

Wanda (`wanda_paper`) is the cheapest viable pruning path: weight
magnitude times activation norm, no Hessian inversion, no gradient passes.
For E1 we should adopt Wanda + light fine-tuning as the default 2:4 path
and SparseGPT only when the 0.5..1 pp accuracy delta matters.

`maskllm_paper` shows that 2:4 masks can be learned end-to-end via
Gumbel-Softmax. This is the upper bound on accuracy. It implies that the
2:4 sparse path is not just "free TOPS"; the compiler must support a
pipeline that produces and consumes 2:4 weights, including support for
training-time mask sampling if we ever ship custom on-device fine-tuning.

## What the 2:4 path needs in hardware

- A 4-bit metadata word per group of 4 INT4 weights that selects which 2
  positions are nonzero (the current `SDOT4_S4_2_4` already does this at
  scalar scale).
- A multiplexer on the activation read port that pulls the right two
  activation lanes from the K-dim of the input matrix. This is the
  classic "structured sparse tensor core" datapath.
- Group-scaled INT4 weight storage so that 2:4 INT4 weights also carry
  per-group scales (see `02_analysis/quantization_int4_int2_fp8.md`).
- Per-row int32 accumulation as today, since 2:4 doubles the effective
  K-dim per cycle but not the precision.

For E1, the cleanest design is a sparsity-decode microengine in front of
the dense INT4 tile: it expands a 2:4 row into the dense lanes that the
existing tile already consumes. No tile redesign, just a packed-to-dense
expander with its own metadata path.

## Unstructured sparsity

`sparsegpt_paper` reports 50% unstructured sparsity on 175B-class models
with negligible accuracy loss. Hardware for unstructured sparsity is much
harder (SCNN, SparTen, Sigma, MAERI all attempt it). The relevant
references are:

- **SIGMA** (`sigma_paper`) — sparse / irregular GEMM with a flexible
  forwarding adder network. The most credible academic reference for an
  unstructured sparse GEMM engine.
- **MAERI** (`maeri_paper`) — reconfigurable interconnect for irregular
  dataflow, supporting unstructured sparse mappings.

E1 should not chase unstructured sparsity in the L2 / L3 / L4 windows.
The accuracy gain over 2:4 is small relative to the area cost, and the
software path is much heavier. Unstructured remains an option for an L5+
revision if MLPerf-class evidence demands it.

## Attention accelerators

The current E1 attention smoke path uses `GEMM_S8` / `GEMM_S4` for QK and
AV with software-side softmax. This is sufficient for the
"single_head_transformer_block_smoke_only" claim but does not produce
the latency or perf/W needed for L4 / L5.

### FlashAttention family

- **FlashAttention** (`flashattention_paper`) — tile-by-tile attention
  without materializing the full score matrix. Required reading for any
  attention engine.
- **FlashAttention-2** (`flashattention2_paper`) — work-partitioning
  optimization that gets to 50-73% of theoretical FLOPs on A100.
- **FlashAttention-3** (`flashattention3_paper`) — warp-specialized
  asynchrony and FP8 attention; 2.6x lower numerical error than baseline
  FP8 attention.

E1 attention engine ABI should match the FlashAttention tile pattern:
- Q tile, K tile, V tile, O tile in scratchpad.
- Streaming softmax accumulation: running max + running sum + running
  output.
- Optional FP8 or INT8 K/V load with per-block scale.
- No materialized score matrix in DRAM.

### Spatial attention accelerators

- **FuseMax** (`fusemax_paper`) — MICRO 2024. ~100% PE utilization in the
  spatial array, on-chip buffer independent of sequence length, average
  6.7x speedup over FLAT with 79% of the energy.
- **SpAtten** (`spatten_paper`, `spatten_repo`) — HPCA 2021. Cascade
  token + head pruning with progressive KV-quantization that reads
  most-significant bits first.
- **A3** (`a3_paper`) — HPCA 2020 approximation-based attention; mostly
  historical anchor.
- **ELSA** — hardware-software co-design for efficient self-attention; the
  ELSA name now also covers a separate 2026 vision-transformer paper
  (`a3_paper` family).

For E1 specifically:

- FuseMax is the architectural reference for a future dedicated attention
  tile. The "no softmax bottleneck" property is critical for a phone NPU
  because the softmax row reduction is otherwise the long pole.
- SpAtten's progressive-KV-bit-width is directly compatible with
  `02_analysis/quantization_int4_int2_fp8.md`'s 2/3-bit KV recommendation.

## On-device LLM serving — software impact on hardware

The serving algorithms below are not optional for hitting the workload
targets in `npu-2028-target.workload_targets`. They are how
`llm_3b_int4_tokens_per_second_sustained_min: 100` becomes possible at
the phone power envelope.

- **PagedAttention / vLLM** (`vllm_paged_attention`) — OS-style paging of
  KV cache. The KV cache for an active 7B INT4 model with 32K context
  is on the order of GBs; only paging makes it fit on a phone with
  multiple concurrent agents. The E1 IOMMU and command-buffer design
  must accept the paged-attention page-table indirection.
- **StreamingLLM** (`streamingllm_paper`) — "attention sink" with a
  small initial-token cache enabling arbitrarily long streams. The
  cheapest KV-cache management policy.
- **H2O** (`h2o_paper`) — heavy-hitter dynamic KV eviction. The lowest-
  accuracy-loss eviction policy in the survey.
- **KIVI** (`kivi_paper`) — tuning-free asymmetric 2-bit KV cache.
- **Multi-Head Latent Attention (MLA)** (`deepseek_v2_mla`,
  `mla_hardware_paper`) — DeepSeek's low-rank KV compression. Reduces KV
  bandwidth dramatically and is rapidly becoming the dominant
  bandwidth-saver in 2025-2026 production LLMs.

### Speculative decoding

- **Medusa** (`medusa_paper`) — 2.3-3.6x token-rate uplift via tree
  attention over multiple decoding heads.
- **EAGLE-2** (`eagle2_paper`) — dynamic draft trees, 3.05-4.26x uplift,
  20-40% faster than EAGLE-1.

For E1, speculative decoding is a software multiplier on the
sustained-tokens-per-second target. To realize the multiplier:

- The descriptor ring must support tree-attention shapes (multiple
  candidate continuations verified in a single batched forward).
- The attention engine must accept a structured tree mask, not just a
  causal triangular mask.

## Survey backing

`llm_accelerator_survey` and `kv_cache_survey` provide the cross-paper
taxonomy. `sllm_workshop_iclr2025` covers very recent sparsity-in-LLM
work. These are cited as integrative anchors; specific claims defer to
the primary papers above.

## Recommendation summary

High confidence:

- Add a 2:4 sparse INT4 tile-level GEMM op (not just the scalar
  `SDOT4_S4_2_4`).
- Add support for per-head, per-page KV-cache scales in the attention
  engine ABI.
- Match the FlashAttention tile pattern in the attention engine ABI
  (streaming softmax, no materialized scores).
- Accept page-table indirection on the KV-cache load path for paged
  attention.

Medium confidence:

- Add a tree-mask mode to the attention engine for speculative decoding.
- Add an MLA-friendly low-rank KV path (factored K, V projections).

Lower confidence (defer):

- Unstructured sparsity acceleration. Wait until 2:4 + MLA + KV-cache
  quantization is shipping before paying the area cost.
- Dedicated head-pruning hardware. Software heuristics get enough of the
  benefit for now.
