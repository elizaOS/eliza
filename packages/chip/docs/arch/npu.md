# NPU command ABI

The e1 NPU is a small synthesizable datapath behind a single-cycle MMIO
control interface. Software programs operands, selects an opcode, starts the
command, then polls `CTRL_STATUS.done` or waits for `irq_npu`.

This block is not a phone-class accelerator. It has only a local RTL descriptor
ring and DRAM-to-scratchpad read path, with no IOMMU, cache coherency, tensor
compiler backend, Android NNAPI delegate, production SRAM, or sustained
TOPS/power evidence. It may be cited only as L0 RTL/unit evidence unless a
higher-level report supplies the proof artifacts listed in
`docs/benchmarks/capabilities/README.md`.

```text
write OP_A
write OP_B
write ACC              ; optional, used by MAC/DOT4
write OPCODE
write CTRL_STATUS.start
poll or wait for irq_npu
read RESULT
```

`OPCODE` is read/write; readback returns the programmed low 4 bits. `RESULT_HI`
contains the high word for `MUL_LO` and sign-extension for signed 32-bit
`MAC_S16`/`DOT4_S8`/`DOT8_S4` results.
`MAC_S16`/`DOT4_S8` results.

Implemented opcodes:

| Opcode | Name | Result |
| ---: | --- | --- |
| `0` | `ADD` | `OP_A + OP_B` |
| `1` | `SUB` | `OP_A - OP_B` |
| `2` | `MUL_LO` | low 32 bits of unsigned `OP_A * OP_B`; high word in `RESULT_HI` |
| `3` | `MAC_S16` | signed low-16 multiply plus signed `ACC` |
| `4` | `DOT4_S8` | four packed signed INT8 products plus signed `ACC` |
| `5` | `MAX_U32` | unsigned max |
| `6` | `MIN_U32` | unsigned min |
| `7` | `DOT8_S4` | eight packed signed INT4 products plus signed `ACC` |
| `8` | `GEMM_S8` | bounded scratchpad INT8 GEMM tile, signed int32 output |
| `9` | `GEMM_S4` | bounded scratchpad packed INT4 GEMM tile, signed int32 output |
| `10` | `RELU4_S8` | four packed signed INT8 lanes clamped at zero |
| `11` | `VRELU_S8` | bounded scratchpad signed INT8 vector ReLU in place or copy |
| `12` | `SDOT4_S4_2_4` | two 2:4 sparse INT4 groups selected by packed metadata |
| `13` | `DOT16_S2` | sixteen packed signed INT2 products plus signed `ACC` |
| `14` | `DOT4_FP8_E4M3` | four packed FP8 E4M3 products plus signed Q8.8 `ACC` |
| `15` | `EXP2_NEG_Q0_8` | approximate `2^delta` for signed INT8 `delta <= 0`, returned as Q0.8 |

Status bits:

| Bit | Name | Meaning |
| ---: | --- | --- |
| `0` | `busy` | Command is executing |
| `1` | `done` | Command completed; also drives `irq_npu` |
| `2` | `error` | Unsupported opcode was rejected |

Write `CTRL_STATUS[1]` to clear `done` and `error`. Operands are latched when
`start` is accepted; software should not rely on mid-command register writes
affecting the in-flight operation.

## Scratchpad GEMM prototype

`GEMM_S8` and `GEMM_S4` are concrete tile prototypes, not a tensor subsystem.
Software stages row-major signed inputs into a 64-byte MMIO scratchpad and
programs a bounded command. `GEMM_S8` stores one signed INT8 value per byte.
`GEMM_S4` stores two signed INT4 values per byte, low nibble first; for this
opcode the `A` and `B` base/stride fields are INT4 element offsets while the
`C` base/stride fields remain byte offsets. Both commands perform one multiply
accumulate per cycle and write row-major signed int32 `C` results back into the
scratchpad. The current RTL bounds are `M <= 3`, `N <= 3`, `K <= 7`, further
limited by the 64-byte scratchpad footprint.

`SDOT4_S4_2_4` is a scalar sparse metadata primitive for INT4. `OP_A[15:0]`
holds four signed INT4 nonzero weights. `OP_B[31:0]` holds eight signed INT4
dense activation lanes, interpreted as two groups of four. `ACC[7:0]` carries
four 2-bit positions, two positions for each group. The opcode multiplies each
nonzero weight by the selected dense lane from its group and returns the signed
int32 sum. Runtime validation requires positions to be in `0..3` and distinct
inside each 2:4 group. `lower_sparse_int4_matmul_smoke` lifts this primitive
into a bounded sparse-weight matmul evidence path for `stablehlo.dot_general`,
`stablehlo.dot`, `tflite.fully_connected`, `tflite.batch_matmul`,
`tflite.matmul`, `eliza.sparse_2_4_matmul`, and `eliza.sparse_int4_matmul`
records. It accepts a dense signed INT4 activation matrix plus per-8-K-block
2:4 sparse INT4 weight values and metadata positions. Host code validates the
INT4 ranges and metadata, pads K to the sparse block width with zero INT4
values when needed, dispatches each sparse block through `SDOT4_S4_2_4`, and
accumulates sparse partial sums through `OP_ADD`. The returned evidence records
the output matrix, golden matrix, sparse block count, `sdot4_count`, padded K,
`host_pads_k_to_sparse_blocks`, `host_uses_2_4_metadata`,
`cpu_fallback=false`, and the claim boundary
`sparse_int4_2_4_matmul_sdot4_smoke_only_not_sparse_tensor_gemm_or_production_compiler_backend`.

This proves scalar-dot sparse INT4 matmul orchestration only. It is not a
sparse tensor GEMM, sparse tensor-core throughput path, hardware metadata
scheduler, pruning/calibration flow, Android delegation, production compiler
backend, or sustained TOPS/W claim.

`DOT16_S2` is the first INT2 execution primitive. `OP_A` and `OP_B` each pack
sixteen signed 2-bit lanes, low lane first, using the two's-complement range
`[-2, 1]`. The opcode returns the signed int32 sum of lane-wise products plus
signed `ACC`. `lower_int2_matmul_smoke` lifts this primitive into a bounded
INT2/BitNet-style matmul evidence path for `stablehlo.dot_general`,
`stablehlo.dot`, `tflite.fully_connected`, `tflite.batch_matmul`,
`tflite.matmul`, `eliza.int2_matmul`, and `eliza.bitnet_matmul` records. Host
code validates the signed INT2 range, pads K to the sixteen-lane dot width with
INT2 zero values when needed, and dispatches every INT2 MAC chunk through
`DOT16_S2` with signed int32 accumulation. The returned evidence records the
output matrix, golden matrix, dot16 dispatch count, padded K,
`host_pads_k_to_dot16`, `cpu_fallback=false`, and the claim boundary
`int2_matmul_dot16_smoke_only_not_tensor_int2_gemm_or_production_compiler_backend`.

This proves scalar-dot INT2 matmul orchestration only. It is not a tensor INT2
GEMM, BitNet production kernel, sparsity-aware INT2 tensor path, graph
partitioning, Android delegation, production compiler backend, or sustained
TOPS/W claim.

`DOT4_FP8_E4M3` is the first FP8 execution primitive. `OP_A` and `OP_B` each
pack four raw FP8 E4M3 values, low byte first. The RTL decodes each lane to
signed Q8.8 fixed point, multiplies lane pairs, shifts each product back to
Q8.8, adds signed Q8.8 `ACC`, and returns the signed Q8.8 result in `RESULT`.
`lower_fp8_matmul_smoke` lifts this primitive into a bounded FP8 E4M3 matmul
evidence path for raw FP8 byte matrices from `stablehlo.dot_general`,
`stablehlo.dot`, `tflite.fully_connected`, `tflite.batch_matmul`,
`tflite.matmul`, and `eliza.fp8_matmul` records. Host code validates byte
ranges, pads K to the four-lane dot width with FP8 zero bytes when needed, and
dispatches every FP8 MAC chunk through `DOT4_FP8_E4M3` with signed Q8.8
accumulation. The returned evidence records the Q8.8 output matrix, golden
Q8.8 matrix, dot4 dispatch count, padded K, `host_pads_k_to_dot4`,
`cpu_fallback=false`, and the claim boundary
`fp8_e4m3_matmul_dot4_smoke_only_not_tensor_fp8_gemm_or_production_compiler_backend`.

This proves scalar-dot FP8 matmul orchestration only. It is not a tensor FP8
GEMM, FP8 systolic path, FP16/BF16 accumulation path, graph partitioning,
Android delegation, production compiler backend, or sustained TOPS/W claim.

## Block-scaled microformats (planned, L2)

The production FP family for E1 is the Open Compute Project (OCP) Microscaling
specification (`ocp_mx_spec`, `mx_formats_paper`, `microxcaling_repo`,
`ptq_mx_paper`). MX formats group 32 lane elements that share a single E8M0
scale; lane payloads are MXFP8 (E5M2 or E4M3), MXFP6 (E3M2 or E2M3), MXFP4
(E2M1), and MXINT8. Operand fetch is block-scaled: hardware reads 32 lane
elements and one E8M0 exponent, scales lanes against the shared exponent, and
multiply-accumulates into a wider FP/INT accumulator.

The current `DOT4_FP8_E4M3` opcode is unscaled scalar evidence only. It is not
the production format, and no MX block-scaled lane fetch, MX accumulator, or MX
compiler lowering exists in the repo today. MX adoption lands in `L2` together
with the parameterized tile and is tracked through:

- `docs/spec-db/e1-npu-runtime-contract.json`
  `precision_matrix` entries `MXFP8`, `MXFP6`, `MXFP4`, `MXINT8` carrying
  `state: blocked_l2_planned` and the same MX block-scale citation.
- `docs/spec-db/npu-2028-target.yaml` `precision_requirements.required`
  includes `mxfp8`, `mxfp6`, `mxfp4`, `mxint8` with the OCP MX block-scale
  footnote.

## Group-scaled INT4 weights (planned, L1)

W4A16-style group-scaled INT4 weight execution lands as
`GEMM_S4_GS32`, `GEMM_S4_GS64`, and `GEMM_S4_GS128` (`gptq_paper`,
`awq_paper`, `omniquant_paper`, `hqq_repo`). Weight storage is packed signed
INT4 (two lanes per byte, low nibble first). Every 32 / 64 / 128 contiguous K
lanes share one INT8 or BF16 scale value. Activations remain INT8 (or higher
precision once the tile carries BF16). The accumulator stays signed int32, and
the host applies the per-group scale during requantization.

These opcodes have no RTL or compiler implementation today. They land in `L1`
and are tracked in `docs/spec-db/e1-npu-runtime-contract.json` as
`phase: L1_planned` with the field shapes above; `docs/spec-db/npu-2028-target.yaml`
`precision_requirements.required` includes `int4_group_scaled` for the same
reason.

## Tile-level 2:4 sparse INT4 GEMM (planned, L2)

`SDOT4_S4_2_4` is the current scalar 2:4 metadata primitive (see above). The
tile-level lift is `GEMM_S4_2_4` (`sparsegpt_paper`, `wanda_paper`,
`maskllm_paper`, `trainium2_aws_docs`): a sparsity-decode microengine consumes
packed INT4 weights with two nonzero positions per four-lane group, expands
each row into the same dense lane input the existing INT4 tile already
consumes, and dispatches MACs through the parameterized tile without
redesigning the MAC array. Effective throughput targets the Trainium2
4x-sparse-INT8 ratio extrapolated to INT4.

There is no RTL, no compiler lowering, and no sparsity-decode microengine
today. The opcode lands at `L2` and is tracked in
`docs/spec-db/e1-npu-runtime-contract.json` as `phase: L2_planned`; the
`sparse_int4_tile_2_4` capability appears in
`docs/spec-db/npu-2028-roadmap.yaml` `L2_SINGLE_TILE_ACCELERATOR`.

## Matmul Lowering Smoke Path

`compiler/runtime/e1_npu_lowering.py` provides a single-op lowering smoke path
for tiny StableHLO/TFLite-style matmul records. It accepts
`stablehlo.dot_general`, `stablehlo.dot`, `tflite.fully_connected`,
`tflite.batch_matmul`, and `tflite.matmul` records using `int8` or `int4`
operands, validates they fit the current bounded GEMM prototype, and dispatches
to `GEMM_S8` or `GEMM_S4` through the runtime ABI. The returned evidence records
the selected opcode, result, golden result, tile count, `cpu_fallback=false`,
and the claim boundary
`single_matmul_tiled_smoke_only_not_production_compiler_backend`.

The smoke path can split `M`, `N`, and `K` dimensions into multiple `3x3x7`
bounded hardware GEMM commands. The NPU performs the MACs for each tile. The
host stitches complete output tiles and accumulates int32 partial outputs across
split-K chunks, but it does not perform MAC fallback. This proves
multi-tile runtime orchestration over the current bounded GEMM ABI; it is still not a
hardware tensor scheduler.

This is not a production compiler backend. There is no StableHLO parser,
FlatBuffer parser, graph partitioner, quantization calibration, scheduler,
delegate integration, CPU fallback planner, or Android NNAPI/TFLite proof.

The same module also exposes `lower_conv2d_smoke` for a tiny Conv2D evidence
path. It accepts `stablehlo.convolution` and `tflite.conv_2d` records with
batch-1 NHWC inputs, HWIO filters, VALID padding, stride 1, dilation 1, and
`int8` or `int4` operands. Host code materializes im2col and filter matrices,
then calls the matmul smoke path so `GEMM_S8` or `GEMM_S4` performs every
convolution MAC. The returned evidence records output shape, im2col shape,
filter-matrix shape, nested matmul evidence, `host_materializes_im2col=true`,
`cpu_fallback=false`, and the claim boundary
`single_conv2d_im2col_smoke_only_not_production_compiler_backend`.

This proves single-Conv2D im2col runtime orchestration over the current bounded
GEMM ABI. It is not a general convolution compiler: SAME padding,
strided/dilated convolution, grouped/depthwise convolution, layout conversion,
fusion, graph partitioning, Android delegation, and hardware scheduling remain
future work.

`lower_attention_qk_smoke` adds a tiny transformer-score evidence path for
rank-4 `[batch][heads][tokens][head_dim]` query/key tensors. It accepts
`stablehlo.dot_general`, `tflite.batch_matmul`, and `eliza.attention_qk`
records using `int8` or `int4` operands. Host code iterates batch/head slices
and transposes each key matrix, then calls the matmul smoke path so `GEMM_S8`
or `GEMM_S4` performs every QK score MAC. The returned evidence records score
shape, head count, head dimension, nested per-head matmul evidence, total tile
count, `host_transposes_keys=true`, `host_iterates_heads=true`,
`cpu_fallback=false`, and the claim boundary
`attention_qk_scores_smoke_only_not_softmax_or_production_compiler_backend`.

This proves attention-QK score runtime orchestration only. It is not a complete
attention kernel: scaling, masking, softmax, value projection, KV-cache paging,
fusion, graph partitioning, Android delegation, and hardware scheduling remain
future work.

`lower_attention_softmax_smoke` adds a bounded attention-softmax evidence path
for rank-4 `[batch][heads][tokens][key_tokens]` int8 logits and an optional
boolean mask. It accepts `stablehlo.softmax`, `tflite.softmax`, and
`eliza.attention_softmax` records. Host code validates the mask and requires
each row's active logit spread to fit the scalar `EXP2_NEG_Q0_8` delta range
before dispatching NPU work. For each row, scalar `MAX_U32` over biased int8
values finds the row max, `OP_SUB` forms non-positive deltas,
`EXP2_NEG_Q0_8` computes power-of-two Q0.8 exponent approximations, and
`OP_ADD` accumulates row sums. Host code applies the mask and performs the
final reciprocal division to produce Q0.8 attention weights. The returned
evidence records row maxima, exponent approximations, row sums, scalar
operation counts, `host_applies_mask=true`, `host_divides_by_row_sum=true`,
`cpu_fallback=false`, and the claim boundary
`attention_softmax_exp2_q0_8_smoke_only_not_production_softmax_or_fused_attention`.

This proves approximate attention-softmax scalar runtime orchestration only.
It is not exact exp/e softmax, a hardware reciprocal/divider, vector softmax
datapath, scale fusion, causal-mask hardware, fused attention, Android
delegation, or a production compiler backend.

`lower_attention_av_smoke` adds the companion attention-value context evidence
path for rank-4 `[batch][heads][tokens][key_tokens]` attention weights and
`[batch][heads][key_tokens][value_dim]` value tensors. It accepts
`stablehlo.dot_general`, `tflite.batch_matmul`, and `eliza.attention_av`
records using `int8` or `int4` operands. Host code iterates batch/head slices
and requires prequantized attention weights, then calls the matmul smoke path
so `GEMM_S8` or `GEMM_S4` performs every AV context MAC. The returned evidence
records context shape, head count, value dimension, nested per-head matmul
evidence, total tile count, `requires_prequantized_attention=true`,
`host_iterates_heads=true`, `cpu_fallback=false`, and the claim boundary
`attention_av_context_smoke_only_not_softmax_or_production_compiler_backend`.

This proves attention-AV context runtime orchestration only. It is not a
complete attention kernel: softmax, scaling, masking, score normalization,
KV-cache paging, fusion, graph partitioning, Android delegation, and hardware
scheduling remain future work.

`lower_attention_smoke` composes the QK, softmax, and AV evidence paths into a
bounded multi-head attention lowering for `eliza.attention`,
`stablehlo.attention`, and `tflite.attention` records. It accepts rank-4 int8
query/key/value tensors and an optional boolean mask. The path calls
`lower_attention_qk_smoke`, requantizes QK scores to int8 logits on host, calls
`lower_attention_softmax_smoke`, requantizes Q0.8 attention weights to int8,
calls `lower_attention_av_smoke`, and requantizes the context tensor. The
returned evidence records QK scores, logits, approximate softmax weights,
attention weights, AV context, requantized context, head count, tile count,
`computes_qk_scores=true`, `computes_attention_softmax=true`,
`requires_prequantized_attention=false`, `host_requantizes_qk_scores=true`,
`host_requantizes_attention_weights=true`, `host_requantizes_context=true`,
`cpu_fallback=false`, and the claim boundary
`multihead_attention_qk_exp2_softmax_av_smoke_only_not_fused_flash_attention_or_production_compiler_backend`.

This proves multi-head attention runtime orchestration over current smoke
primitives only. It is not fused flash attention, exact exp/e softmax, scaling
fusion, KV-cache paging/update, graph partitioning, Android delegation, a
production compiler backend, or sustained transformer decode evidence.

`lower_kv_cache_update_smoke` adds a bounded decode-state evidence path for
`eliza.kv_cache_update`, `stablehlo.kv_cache_update`, and
`tflite.kv_cache_update` records. It accepts rank-4
`[batch][heads][capacity][dim]` int8 key/value cache tensors, rank-4 new
key/value tensors, and per-head cache lengths. Host code validates capacity and
append lengths, preserves existing cache entries, dispatches every appended
K/V scalar copy through `OP_ADD(value, 0)`, writes appended tokens into fixed
cache positions, and advances cache lengths. The returned evidence records the
updated key/value caches, new lengths, appended token count, head/value
dimensions, scalar copy count, `host_preserves_existing_cache=true`,
`host_tracks_cache_lengths=true`, `cpu_fallback=false`, and the claim boundary
`kv_cache_update_s8_scalar_append_smoke_only_not_paged_or_dma_cache`.

This proves append-only KV-cache runtime orchestration only. It is not a paged
KV cache, cache eviction policy, circular buffer, DMA-backed cache update,
multi-batch decode cache manager, Android delegation, graph compilation, or a
production transformer decode cache path.

`lower_decode_attention_smoke` composes append-only K/V cache update with the
multi-head attention smoke path. It accepts `eliza.decode_attention`,
`stablehlo.decode_attention`, and `tflite.decode_attention` records with rank-4
query tensors, fixed-capacity rank-4 key/value caches, rank-4 new key/value
tensors, and per-head cache lengths. The path validates all shifts before
MMIO, calls `lower_kv_cache_update_smoke`, materializes a rectangular
cache-view up to the maximum updated head length, masks padded cache lanes, and
calls `lower_attention_smoke` so QK-softmax-AV runs over the updated cache. The
returned evidence records the K/V cache update result, cache-view tensors,
attention mask, updated cache lengths, maximum attention cache length,
`updates_kv_cache=true`, `computes_attention_over_cache=true`,
`host_materializes_cache_view=true`, `cpu_fallback=false`, and the claim
boundary
`decode_attention_kv_append_qk_softmax_av_smoke_only_not_paged_cache_flash_attention_or_production_compiler_backend`.

This proves decode-attention runtime orchestration only. It is not a paged KV
cache, cache eviction policy, circular buffer, DMA-backed cache update, fused
flash attention, multi-batch cache manager, Android delegation, graph
compilation, or production transformer decode kernel.

`lower_mlp_smoke` adds a tiny transformer feed-forward evidence path. It
accepts `stablehlo.mlp`, `tflite.mlp`, and `eliza.transformer_mlp` records
using `int8` operands and ReLU activation. Host code validates both projection
shapes before MMIO, dispatches the up-projection MACs through `GEMM_S8`,
requantizes the hidden int32 accumulator to int8, runs activation through
`VRELU_S8`, and dispatches the down-projection MACs through `GEMM_S8`. The
returned evidence records hidden accumulator values, hidden requantized values,
hidden activated values, nested up/down matmul evidence, total GEMM tile count,
`host_requantizes_hidden=true`, `activation_opcode=VRELU_S8`,
`cpu_fallback=false`, and the claim boundary
`transformer_mlp_relu_smoke_only_not_gelu_or_production_compiler_backend`.

This proves transformer-MLP ReLU runtime orchestration over the current bounded
GEMM and VRELU ABIs. It is not a production feed-forward compiler path:
GELU/SwiGLU, fused bias add, fused residual add, normalization, activation
fusion, graph partitioning, Android delegation, and hardware scheduling remain
future work.

`lower_swiglu_smoke` adds a gated transformer-MLP evidence path for
`eliza.swiglu`, `eliza.gated_mlp`, `stablehlo.swiglu`, and `tflite.swiglu`
records. It accepts int8 inputs, up-projection weights, gate-projection
weights, and down-projection weights. The NPU runs up and gate projection MACs
through `GEMM_S8`, then executes every elementwise gate product through scalar
`OP_MUL_LO`; host code applies the fixed-point gate shift and int8 saturation.
The down projection then runs through `GEMM_S8`. The returned evidence records
up/gate accumulators, requantized hidden tensors, gated hidden tensor, nested
matmul evidence, scalar multiply count, `cpu_fallback=false`, and the claim
boundary
`swiglu_s8_scalar_gate_smoke_only_not_silu_or_production_compiler_backend`.

This proves gated-MLP scalar runtime orchestration only. It is not a true SiLU
or sigmoid implementation, vector gate datapath, fused SwiGLU kernel, graph
compiler path, Android delegation, or production transformer MLP kernel.

`lower_bias_add_smoke` adds a tiny int8 row-wise bias-add evidence path for
`stablehlo.add`, `tflite.add`, and `eliza.bias_add` matrix records. Host code
validates the bias width, broadcasts the bias vector over input rows, and the
NPU executes each elementwise add through scalar `OP_ADD`; host code interprets
the signed int32 result and saturates it to int8. The returned evidence records
input shape, bias shape, element count, scalar add count,
`host_broadcasts_bias=true`, `host_saturates_int8=true`, `cpu_fallback=false`,
and the claim boundary
`bias_add_s8_scalar_broadcast_smoke_only_not_vector_or_production_compiler_backend`.

This proves row-wise bias-add scalar broadcast orchestration only. It is not a
vector add datapath or fused projection bias path: arbitrary-rank broadcasting,
normalization, graph partitioning, Android delegation, and hardware scheduling
remain future work.

`lower_residual_add_smoke` adds a tiny int8 residual-add evidence path for
`stablehlo.add`, `tflite.add`, and `eliza.residual_add` matrix records. Host
code validates equal shapes before MMIO. The NPU executes each elementwise add
through scalar `OP_ADD`; host code interprets the signed int32 result and
saturates it to int8. The returned evidence records the output shape, element
count, scalar add count, `host_saturates_int8=true`, `cpu_fallback=false`, and
the claim boundary
`residual_add_s8_scalar_smoke_only_not_vector_or_production_compiler_backend`.

This proves residual-add scalar runtime orchestration only. It is not a vector
add datapath or fused transformer residual path: arbitrary broadcast add,
normalization, graph partitioning, Android delegation, and hardware scheduling
remain future work.

`lower_transformer_block_smoke` composes the current primitive lowerings into a
tiny batch-1, single-head transformer block. It accepts
`eliza.transformer_block`, `stablehlo.transformer_block`, and
`tflite.transformer_block` records using int8 operands, prequantized attention
weights, row-wise attention bias, and a ReLU MLP. The path calls
`lower_attention_av_smoke`, `lower_bias_add_smoke`, `lower_residual_add_smoke`,
`lower_mlp_smoke`, and a second `lower_residual_add_smoke`. The returned
evidence records attention context, biased attention output, post-attention
residual, MLP output, final output, nested primitive evidence, total GEMM tile
count, scalar add count, `requires_prequantized_attention=true`,
`cpu_fallback=false`, and the claim boundary
`single_head_transformer_block_smoke_only_not_softmax_norm_multihead_or_production_compiler_backend`.

This proves single-head transformer-block runtime orchestration over current
NPU-backed smoke primitives. It is not a production transformer compiler path:
QK generation inside the block, softmax, scaling, masking, layer normalization,
multi-head merge, KV-cache paging, fused kernels, Android delegation, and
hardware scheduling remain future work.

`lower_modern_decoder_block_smoke` composes the newer transformer primitive
evidence into a tiny batch-1, single-head decoder block. It accepts
`eliza.decoder_block`, `stablehlo.decoder_block`, and `tflite.decoder_block`
records using int8 operands, RMSNorm weights, Q/K/V projection weights,
an optional boolean attention mask, rotary cosine/sine tables, row-wise
attention bias, and SwiGLU weights. The path calls `lower_rmsnorm_smoke`,
three `lower_matmul_smoke` Q/K/V projections, host Q/K/V requantization,
`lower_rope_smoke` for Q and K, `lower_attention_qk_smoke`, host QK-score
requantization, `lower_attention_softmax_smoke`, host Q0.8 attention-weight
requantization, `lower_attention_av_smoke`, `lower_bias_add_smoke`,
`lower_residual_add_smoke`, a second `lower_rmsnorm_smoke`,
`lower_swiglu_smoke`, and a final `lower_residual_add_smoke`. The returned
evidence records normalized tensors, Q/K/V projections, RoPE outputs, QK
scores, requantized QK logits, approximate softmax weights, requantized
attention weights, attention context, residuals, SwiGLU output, final output,
total GEMM tile count, scalar arithmetic counts, `computes_qk_scores=true`,
`computes_attention_softmax=true`, `requires_prequantized_attention=false`,
`host_requantizes_qkv=true`, `host_requantizes_qk_scores=true`,
`host_requantizes_attention_weights=true`, `cpu_fallback=false`, and the claim
boundary
`modern_decoder_block_single_head_exp2_softmax_smoke_only_not_multihead_kv_cache_or_production_compiler_backend`.

This proves modern decoder-block runtime orchestration over current NPU-backed
smoke primitives. It is still not a production transformer decode kernel:
exact exp/e softmax, scaling fusion, multi-head merge, KV-cache paging/update,
vector norm/RoPE/gate/softmax datapaths, fused kernels, Android delegation,
graph compilation, and hardware scheduling remain future work.

`lower_rope_smoke` adds a tiny rotary-position embedding evidence path for
`eliza.rope`, `stablehlo.rope`, and `tflite.rope` records. It accepts int8
matrices with an even model dimension and prequantized int8 cosine/sine tables.
For each value pair, the NPU executes four scalar `OP_MUL_LO` commands plus
scalar `OP_SUB` and `OP_ADD` commands for the rotary arithmetic. Host code then
applies the fixed-point shift and int8 saturation. The returned evidence
records input/trig shapes, scalar multiply/add counts, `cpu_fallback=false`,
`host_applies_shift_and_saturation=true`, and the claim boundary
`rope_s8_scalar_smoke_only_not_vector_or_production_compiler_backend`.

This proves RoPE scalar runtime orchestration only. It is not a vector RoPE
datapath, fused Q/K projection, KV-cache update, graph compiler path, Android
delegation, or production transformer decode kernel.

`lower_rmsnorm_smoke` adds a tiny RMSNorm evidence path for `eliza.rms_norm`,
`stablehlo.rms_norm`, and `tflite.rms_norm` records. It accepts int8 matrices
and int8 per-channel weights. For each row, the NPU executes scalar
`OP_MUL_LO` commands for input squares and scalar `OP_ADD` commands for
sum-of-squares accumulation. It then executes scalar multiply commands for
input-weight products and reciprocal-RMS scaling. Host code computes the
integer reciprocal RMS, then applies the fixed-point shift and int8 saturation.
The returned evidence records row sum-of-squares, row RMS, reciprocal-RMS
scales, scalar multiply/add counts, `cpu_fallback=false`,
`host_computes_reciprocal_rms=true`,
`host_applies_shift_and_saturation=true`, and the claim boundary
`rmsnorm_s8_scalar_smoke_only_not_vector_or_production_compiler_backend`.

This proves RMSNorm scalar runtime orchestration only. It is not a vector
normalization datapath, hardware reciprocal-square-root unit, fused transformer
norm path, graph compiler path, Android delegation, or production transformer
decode kernel.

`RELU4_S8` and `VRELU_S8` are the first activation datapaths. `RELU4_S8`
operates on four packed signed INT8 lanes in `OP_A` and returns four packed
lanes in `RESULT`. `VRELU_S8` uses the scratchpad path: `GEMM_CFG[5:0]` is the
byte length, `GEMM_BASE[5:0]` is the source byte base, and `GEMM_BASE[13:8]` is
the destination byte base. It accepts 1..64 bytes when both ranges fit in the
scratchpad. This is ReLU coverage only; GELU, normalization, softmax, and RoPE
remain future vector-engine work.

Additional registers:

| Offset | Name | Fields |
| ---: | --- | --- |
| `0x20` | `GEMM_CFG` | GEMM: `M[1:0]`, `N[9:8]`, `K[18:16]`; VRELU: `LEN[5:0]` |
| `0x24` | `GEMM_BASE` | GEMM byte bases: `A[5:0]`, `B[13:8]`, `C[21:16]`; VRELU byte bases: `SRC[5:0]`, `DST[13:8]` |
| `0x28` | `GEMM_STRIDE` | byte strides: `A[3:0]`, `B[11:8]`, `C[19:16]` |
| `0x2c` | `PERF_UNSUPPORTED_OPS` | unsupported opcode/configuration counter |
| `0x30` | `CMD_PARAM` | bit 0 selects descriptor-submission mode |
| `0x40` | `DESC_BASE` | descriptor ring base; must be 32-bit aligned |
| `0x44` | `DESC_HEAD` | software producer index, 3 bits |
| `0x48` | `DESC_TAIL` | hardware/software consumer index, 3 bits |
| `0x4c` | `DESC_STATUS` | descriptor status bits plus error index in bits `[11:9]` |
| `0x50` | `PERF_CYCLES` | cycles spent in active state |
| `0x54` | `PERF_MACS` | signed INT8 MAC operations issued |
| `0x58` | `PERF_OPS` | accepted operation counter |
| `0x5c` | `PERF_ERRORS` | rejected commands/configurations; write bit 0 to clear all perf counters |
| `0x60` | `DESC_TIMEOUT_COUNT` | cycles spent in the active descriptor engine |
| `0x64` | `DESC_BYTES_READ` | descriptor plus tensor-stream bytes accepted by the NPU read path |
| `0x68` | `DESC_BYTES_WRITTEN` | descriptor writeback bytes accepted by the NPU write path |
| `0x6c` | `DESC_READ_BEATS` | descriptor plus tensor-stream read beats accepted |
| `0x70` | `DESC_WRITE_BEATS` | descriptor writeback beats accepted |
| `0x80`-`0xbc` | `SCRATCH[0..15]` | 16 little-endian 32-bit scratchpad words |

For row-major `A[M][K]`, `B[K][N]`, and `C[M][N]`, use `A_STRIDE = K`,
`B_STRIDE = N`, and `C_STRIDE = 4*N`. `C_BASE` must be word-aligned. Invalid
dimensions or scratchpad addresses complete with `CTRL_STATUS.done|error` set
and increment `PERF_ERRORS`.

The full v0.1 NPU ABI should extend this pattern:

```text
MMIO control registers
command queue
DMA descriptors
scratchpad allocation
INT8/INT4 GEMM commands
completion interrupt
performance counters
```

Current integration is still a prototype datapath model. When `CMD_PARAM[0]` is
set and software writes `CTRL_STATUS.start`, the RTL validates base alignment
and empty/non-empty queue state, then fetches four 32-bit descriptor words from
the read-only `m_axil_ar/r` descriptor port for each visible queue entry.
Descriptor word 0 carries `opcode[3:0]`, `stream_to_scratch[8]`,
`scratch_offset[21:16]`, `byte_count[29:24]`, `writeback_request[30]`, and
`valid_owner[31]`. Software must set `valid_owner` before advancing `DESC_HEAD`;
the current RTL rejects descriptors without this bit and leaves `DESC_TAIL`
unchanged. Word 1 is the stream source byte address when streaming is enabled,
or scalar `OP_A` otherwise. Word 2 is scalar `OP_B`, or the aligned writeback
destination byte address when `writeback_request` is set for streamed GEMM.
Word 3 is scalar `ACC`, or reserved for streamed GEMM. The stream path is
aligned 32-bit reads only and writes into the 64-byte scratchpad before
launching the selected existing opcode.

`DESC_STATUS[0]` reports empty, `[1]` reports descriptor completion, `[2]`
reports descriptor error, `[3]` reports autonomous timeout, `[4]` reports
descriptor fetch read error, `[5]` reports tensor stream read/configuration
error, `[6]` reports a descriptor missing the valid owner bit, `[7]` reports an
malformed writeback request, `[8]` reports descriptor engine busy, and
`[11:9]` reports the descriptor index that faulted or completed. The three
visible head/tail bits do not encode a full-ring condition. A missing descriptor
or stream read response times out with `CTRL_STATUS.done|error`; read-response
errors fail closed. Streamed GEMM descriptors with `writeback_request` set write
the word-aligned GEMM output tile from scratchpad to the descriptor word-2
destination address through the NPU AXI-Lite write master, and update
`DESC_BYTES_WRITTEN`/`DESC_WRITE_BEATS`. Scalar writeback, vector writeback,
unaligned destinations, and non-word-sized writebacks still fail closed.

## Evidence gates

Before any `e1-npu` benchmark is treated as accelerator evidence, the report
must include:

- exact model SHA-256 and Android/Linux target identity,
- NNAPI accelerator query showing `e1-npu`,
- total/delegated NNAPI node count, zero CPU fallback, and zero unsupported ops,
- precision actually used by the delegate,
- dataflow name and description from the measured path,
- DMA path plus bytes read and written by the NPU workload; current local RTL
  can report descriptor/tensor read counts and streamed GEMM writeback counts,
- descriptor queue depth, head/tail completion evidence, and timeout/error
  behavior for queued commands,
- MACs per inference, NPU cycles, NPU clock, DMA byte counters, operation/error
  counters, observed TOPS, and the TOPS formula,
- Android HAL service, SELinux fail-closed policy, VTS result, and CTS result
  when any Android accelerator claim is made,
- transcript hashes for adb, NNAPI query, benchmark output, and DMA trace.

TOPS is a derived review field, not proof by itself:

```text
observed_tops <= macs_per_inference * 2 / (npu_cycles / npu_hz) / 1e12
```

The current RTL still cannot satisfy those gates because its measured descriptor
GEMM path is a single local read/writeback smoke path with no cache coherency,
production queue ownership, software-owned completion queue, Android delegate,
or power evidence.
