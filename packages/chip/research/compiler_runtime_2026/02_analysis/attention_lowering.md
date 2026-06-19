# Attention lowering in 2026 compiler stacks

Research-only summary of how transformer attention is actually lowered in
mid-2026 production stacks, with notes on what E1's existing
`attention_qk` / `attention_av` / `transformer_block` smoke schemas in
`compiler/runtime/e1_npu_lowering.py` would have to absorb to be more than a
single-head smoke harness.

## 1. The 2026 attention kernel template

Every modern attention kernel for inference follows the FlashAttention
family pattern:

1. Tile Q rows along the sequence dimension.
2. For each Q tile, stream tiles of K and V from HBM/SRAM.
3. Compute `S = Q @ K^T` in a register-tile / scratchpad GEMM.
4. Apply causal/local masks, divide by `sqrt(d_head)`, apply ALiBi/RoPE if
   not already baked into Q/K.
5. Online softmax: maintain row-wise max `m_i` and row-wise sum `l_i`; for
   each new K tile update `m_i_new = max(m_i, m_block)`, rescale the
   accumulator `O = O * exp(m_i - m_i_new) + softmax(S) @ V`.
6. After the last K/V tile, divide `O` by `l_i_final`.

FlashAttention-2 (Dao, ICLR 2024) is the simplest reference; FlashAttention-3
(Shah et al., NeurIPS 2024) adds Hopper-specific producer/consumer
pipelining (WGMMA + TMA) and FP8 paths. ThunderKittens (Stanford) shows the
same template at a more minimal tile-DSL level.

For a systolic NPU like E1, the relevant lowering is the FA-2 shape, not
FA-3: there is no async warp specialization needed on a single descriptor
ring, but the online softmax and accumulator rescaling pattern still
apply.

## 2. Prefill vs decode kernels

Modern serving runtimes (vLLM, SGLang, TensorRT-LLM) keep **two distinct
attention kernels**:

- **Prefill** — `Q` has many rows (sequence length), GEMM-shaped attention
  with high arithmetic intensity. Standard FA-2/3 tiling applies.
- **Decode** — `Q` has one row (`M = 1`), so attention is GEMV-shaped and
  memory-bound. The dominant 2024-2026 technique is **Flash-Decoding**
  (Stanford CRFM blog, 2023): split the K/V sequence dimension, do
  independent GEMV reductions per split, then reduce across splits.

E1's existing smoke paths do not distinguish prefill from decode. A real
compiler must emit separate dispatches for the two cases, because the tile
shape, scratchpad layout, and KV-cache access pattern are all different.

## 3. KV-cache layout: paged attention

**vLLM PagedAttention** (Kwon et al., SOSP 2023) defines the canonical
2026 KV-cache layout:

- KV memory is split into fixed-size blocks (e.g. 16 or 32 tokens).
- Each sequence has a **block table** mapping logical token positions to
  physical block IDs.
- The attention kernel reads K and V by walking the block table; tokens
  within a sequence are not contiguous in physical memory.

For an NPU descriptor ring this maps cleanly to gather operations or to a
per-block dispatch. E1 today has no block-paged KV-cache abstraction; the
`attention_qk` smoke schema assumes contiguous K. Adding paged attention is
a software-side change first (compiler lowering + DMA descriptors) and
only later a microarch optimization (e.g. a scatter-gather descriptor
format).

## 4. RoPE fusion

RoPE (Su et al., *RoFormer*, 2021) is the dominant positional encoding in
2025-2026 LLMs (Llama, Gemma, Mistral, Qwen). The standard lowering
**fuses** the rotary multiplication into the QK projection: rather than
materializing rotated Q and K, the kernel applies the cos/sin rotation to
each head dim pair as part of the GEMM epilogue.

For E1, RoPE is a small element-wise op fused with the QK matmul. A real
compiler must:

1. Recognize the RoPE pattern from StableHLO / FX (it appears as a
   pair of slices + sin/cos multiplies + add).
2. Fuse it into the attention pre-dispatch step, or emit it as a
   scratchpad-resident element-wise op pre-GEMM.

E1 today has no element-wise op infrastructure beyond `VRELU_S8`, so RoPE
either runs on CPU (counts against the 1% CPU-fallback budget in
`docs/spec-db/npu-2028-target.yaml`) or requires a new opcode.

## 5. Grouped-Query Attention (GQA) and Multi-Query Attention (MQA)

GQA (Ainslie et al., EMNLP 2023) is the default attention shape in
Llama-3, Llama-4, Gemma-2/3, Mistral, Qwen-3. K and V are shared across
groups of query heads; the resulting K and V tensors are much smaller than
in MHA.

This changes the lowering in two ways:

- The Q tensor still has `n_heads` head dim, but K and V have
  `n_kv_heads`. The K/V tiles are **broadcast** across query groups in the
  attention dot products.
- KV-cache memory is `n_kv_heads / n_heads` of MHA, which dominates the
  practical KV-quantization gains.

E1's `attention_qk` smoke schema does not encode `n_kv_heads` separately
from `n_heads`. A real compiler path must accept the GQA shape from the
frontend and emit the correct broadcast pattern.

## 6. Sliding-window / local attention

Mistral / Gemma use **sliding-window attention** where each token only
attends to the last `W` tokens. This compresses KV-cache memory at the
cost of attention being non-rectangular along the K axis. The compiler
must:

1. Track the window in the partitioner so KV memory is bounded.
2. Emit a masking pattern on the QK matmul or skip K blocks that fall
   outside the window.

This is straightforward to add to a FA-2-style kernel; it is currently
absent from E1's smoke schemas.

## 7. Quantized attention

For W4A4 / W4A8 inference (SpinQuant, QuaRot, Atom):

- Q, K, V projections produce INT4 / INT8 outputs with per-token scales.
- The QK matmul accumulates in INT32, then re-scales to BF16/FP16 for
  softmax (which is **not** quantized — softmax stays in BF16/FP16 because
  it is numerically sensitive).
- The PV matmul takes INT8/INT4 V tiles and an FP16 softmax probability
  tensor; the standard pattern is to quantize the softmax output to INT8
  immediately before the PV matmul.

This pattern has two implications for E1:

1. The compiler must emit a **softmax** dispatch that runs in BF16/FP16.
   E1 has no BF16/FP16 datapath; this is the most common reason 2024-2026
   NPUs ended up with a small vector / SFU unit alongside the tensor core.
2. The KV cache stores INT8 (or quantized FP8 / INT4) values; the
   attention dispatch must dequantize per block, accumulate higher-precision,
   then re-quantize.

E1's `attention_qk` / `attention_av` smoke today do not model softmax,
scaling, or dequantize. Adding them is a software-and-RTL combined gap.

## 8. What E1's compiler path must add

Mapping to `docs/spec-db/npu-2028-target.yaml` software targets, the
attention-specific work is:

1. **Two kernels** — separate prefill (GEMM-shaped) and decode
   (GEMV-shaped, Flash-Decoding) attention dispatches.
2. **Online softmax** — either as a host-side BF16/FP16 op or as a new
   E1 vector op.
3. **Paged KV-cache** — block table abstraction in the compiler IR;
   descriptor-ring DMA that walks the block table.
4. **RoPE fusion** — element-wise op fused with QK projection.
5. **GQA / MQA shapes** — recognize `n_kv_heads` and emit broadcast tiles.
6. **Sliding-window masking** — bounded K-axis iteration.
7. **Quantized attention** — INT4/INT8 KV with per-block scales, scale
   propagation through softmax and PV.

Items 1, 4, 5, 6 are purely compiler-side and can land on top of today's
`attention_qk` / `attention_av` smoke schemas. Items 2, 3, 7 need RTL or
microarch support and are real microarchitecture gaps, not compiler-only
gaps. Both classes are tracked in `03_implementation/e1_compiler_path.md`.
