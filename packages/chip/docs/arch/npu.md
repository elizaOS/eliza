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

### BitNet ternary mode on `DOT16_S2`

When `CMD_PARAM[1]=1` is set before a `DOT16_S2` dispatch, the RTL switches the
sixteen packed lanes from two's-complement INT2 to ternary `{-1, 0, +1}`. The
ternary decode is:

| Lane bits | Value |
| :---: | :---: |
| `0b00` | `0` |
| `0b01` | `+1` |
| `0b10` | `-1` |
| `0b11` | reserved (fail-closed) |

`OP_A` and `OP_B` still pack sixteen 2-bit lanes, low lane first; `RESULT`
returns the signed int32 sum of lane-wise ternary products plus signed `ACC`,
in the same format as the default `DOT16_S2` path. If any lane in either
operand decodes to the reserved `0b11` encoding, the RTL leaves `RESULT` and
`RESULT_HI` unchanged, sets `CTRL_STATUS.error`, and increments `PERF_ERRORS`.
Software then has to clear the error with the normal `CTRL_STATUS[1]` write
before issuing the next command.

The ternary mode is latched at command launch from `CMD_PARAM[1]`. It applies
to both the direct MMIO scalar dispatch and to a descriptor-driven scalar
launch of `DOT16_S2`. Other opcodes ignore `CMD_PARAM[1]`. The mode is
prototype-only: it is not a tensor INT2 GEMM, a BitNet production kernel, a
sign-flip/sum dedicated multiplier-free datapath, sparsity-aware INT2 tensor
path, graph partitioning, Android delegation, production compiler backend, or
sustained TOPS/W claim. Sources: `bitnet_b1_58_paper`, `bitnet_a4_8_paper`,
`bitnet_2b4t_hf`.

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

`lower_fp16_matmul_smoke` and `lower_bf16_matmul_smoke` add bounded mixed-FP
evidence paths for raw IEEE FP16 and BF16 matrix records from
`stablehlo.dot_general`, `stablehlo.dot`, `tflite.fully_connected`,
`tflite.batch_matmul`, `tflite.matmul`, `eliza.fp16_matmul`, and
`eliza.bf16_matmul`. Host code validates raw 16-bit encodings, rejects
NaN/Inf/subnormal values, converts finite normal/zero values to signed Q8.8,
dispatches each scalar product through `MUL_LO`, requantizes each Q16.16 product
back to Q8.8, and dispatches accumulation through `ADD`. The returned evidence
records the converted Q8.8 inputs, Q8.8 output matrix, golden Q8.8 matrix,
scalar multiply/add counts, `host_converts_float16_to_q8_8=true`,
`host_requantizes_products=true`, `cpu_fallback=false`, and the claim boundaries
`fp16_matmul_q8_8_scalar_smoke_only_not_tensor_fp16_gemm_or_production_compiler_backend`
and
`bf16_matmul_q8_8_scalar_smoke_only_not_tensor_bf16_gemm_or_production_compiler_backend`.

This proves scalar FP16/BF16 smoke orchestration only. It is not tensor FP16 or
BF16 GEMM, an FP16/BF16 systolic path, a hardware FP accumulator, graph
partitioning, Android delegation, production compiler backend, or sustained
TOPS/W claim.

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

W4A16-style group-scaled INT4 weight execution is now represented by a bounded
scalar smoke path and a planned tensor path. `lower_group_scaled_int4_matmul_smoke`
accepts signed INT8 activation matrices, signed INT4 weight matrices, a positive
`group_size`, and per-K-group per-output-column signed Q8.8 scales for
`stablehlo.dot_general`, `stablehlo.dot`, `tflite.fully_connected`,
`tflite.batch_matmul`, `tflite.matmul`, `eliza.group_scaled_int4_matmul`, and
`eliza.awq_int4_matmul` records. It dispatches each activation-weight product
through `MUL_LO` and `ADD`, then applies every group scale through `MUL_LO` and
accumulates scaled Q8.8 group contributions through `ADD`. The returned evidence
records `group_dot_products`, Q8.8 output and golden matrices, `group_size`,
`group_count`, scalar multiply/add counts, `host_applies_group_scales=true`,
`host_uses_q8_8_scales=true`, `cpu_fallback=false`, and the claim boundary
`group_scaled_int4_matmul_q8_8_scalar_smoke_only_not_gemm_s4_gs_or_production_compiler_backend`.

This proves group-scaled INT4 scalar runtime orchestration only. It is not
`GEMM_S4_GS32`, `GEMM_S4_GS64`, or `GEMM_S4_GS128` RTL, tensor group-scaled
INT4 GEMM, BF16 scale decode, graph partitioning, Android delegation,
production compiler backend, or sustained TOPS/W claim. The tensor opcodes
remain planned for `L1` with packed signed INT4 storage and per-group INT8 or
BF16 scales; `docs/spec-db/npu-2028-target.yaml`
`precision_requirements.required` includes `int4_group_scaled` for that target.

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

This is not a production compiler backend. There is no production StableHLO
parser, FlatBuffer parser, graph partitioner, quantization calibration,
scheduler, delegate integration, CPU fallback planner, or Android NNAPI/TFLite
proof.

The checked Python StableHLO subset in `compiler/runtime/e1_npu_stablehlo.py`
now accepts bounded rank-2 `stablehlo.dot_general` and `stablehlo.dot` records
for the low-precision matmul smoke precisions already exposed by the runtime:
INT8, INT4, INT2/BitNet INT2, FP8 E4M3, FP16, BF16, sparse INT4 2:4, and
group-scaled INT4. Validation keeps the local `3x3x7` tile envelope and rejects
unsupported precisions before lowering. The same module emits parser-only
`LoweringPlan` records that map each accepted precision to the existing runtime
API and graph schema smoke target, including metadata-backed fields for sparse
INT4 and group-scaled INT4, then materializes only those checked runtime smoke
graph records from the required tensor fields. This is a parser/import contract only;
`lower_stablehlo_module_smoke` dispatches materialized modules through the
matching smoke lowerers without CPU fallback for covered ops and reports
`dispatch_order`, `lowering_plans`, and `all_npu_dispatch` metadata. Module
validation rejects empty modules and duplicate op names before lowering. It is
not an MLIR pipeline, graph partitioner, calibration flow, scheduler, or
production compiler backend.

The same import path now covers bounded rank-4 `stablehlo.batch_matmul` records
for INT8 and INT4. `lower_batch_matmul_smoke` validates `[B,H,M,K] x [B,H,K,N]`
shapes, host-iterates batch/head slices, and reuses the existing tiled matmul
smoke path so the current `GEMM_S8`/`GEMM_S4` commands perform every MAC. It
reports nested per-slice matmul evidence, `total_tile_count`,
`host_iterates_batch_heads=true`, `cpu_fallback=false`, and the
`batch_matmul_reuses_tiled_matmul_smoke_only_not_tensor_batch_gemm_or_production_compiler_backend`
claim boundary.

The same module also exposes `lower_conv2d_smoke` for a tiny Conv2D evidence
path. It accepts `stablehlo.convolution` and `tflite.conv_2d` records with
batch-1 NHWC inputs, HWIO filters, VALID padding, stride 1, dilation 1, and
`int8` or `int4` operands. Host code materializes im2col and filter matrices,
then calls the matmul smoke path so `GEMM_S8` or `GEMM_S4` performs every
convolution MAC. The returned evidence records output shape, im2col shape,
filter-matrix shape, nested matmul evidence, `host_materializes_im2col=true`,
`cpu_fallback=false`, and the claim boundary
`single_conv2d_im2col_smoke_only_not_production_compiler_backend`.
The StableHLO import planner now maps checked `stablehlo.convolution` records
to this smoke schema, materializes static NHWC/HWIO, VALID, stride-1,
dilation-1 attributes into the graph record, and dispatches through
`lower_stablehlo_module_smoke` without CPU fallback.

The same parser/import path now accepts bounded rank-4
`stablehlo.attention_qk` and `stablehlo.attention_av` records for INT8 and
INT4. The planner maps them to `lower_attention_qk_smoke` and
`lower_attention_av_smoke`, materializes only the required query/key or
attention/value tensor fields, and dispatches them through
`lower_stablehlo_module_smoke` without CPU fallback. This keeps attention
coverage split at the existing QK and AV smoke boundaries; it is not a fused
softmax attention kernel or production compiler backend.

This proves single-Conv2D im2col runtime orchestration over the current bounded
GEMM ABI. It is not a general convolution compiler: SAME padding,
strided/dilated convolution, grouped/depthwise convolution, layout conversion,
fusion, graph partitioning, Android delegation, and hardware scheduling remain
future work.

`lower_depthwise_conv2d_smoke` adds a separate tiny depthwise Conv2D evidence
path for `stablehlo.depthwise_convolution`, `tflite.depthwise_conv_2d`, and
`eliza.depthwise_conv2d` records. It accepts batch-1 NHWC inputs, HWCM filters,
VALID padding, stride 1, dilation 1, and `int8` operands. Host code iterates
output pixels, input channels, and channel multipliers directly without im2col,
then dispatches each depthwise MAC through scalar `OP_MUL_LO` and `OP_ADD`.
The returned evidence records output shape, input channels, channel multiplier,
scalar multiply/add counts, `host_uses_direct_depthwise_loops=true`,
`host_materializes_im2col=false`, `cpu_fallback=false`, and the claim boundary
`depthwise_conv2d_direct_scalar_smoke_only_not_vector_depthwise_or_production_compiler_backend`.

This proves direct depthwise-Conv2D runtime orchestration over the current
scalar ABI. It is not a vector depthwise datapath or general convolution
compiler: SAME padding, strided/dilated depthwise convolution, fused
activation, Android delegation, and production compiler backend support remain
future work.

`lower_grouped_conv2d_smoke` covers a separate tiny grouped Conv2D evidence
path for `stablehlo.convolution`, `tflite.conv_2d`, and `eliza.grouped_conv2d`
records. It accepts batch-1 NHWC inputs, HWIO filters, an explicit `groups`
field with `1 < groups < input_channels`, VALID padding, stride 1, dilation 1,
and `int8` operands. Host code iterates output pixels, groups, group-local
input channels, and group-local output channels directly without im2col, then
dispatches each grouped-convolution MAC through scalar `OP_MUL_LO` and
`OP_ADD`. The returned evidence records output shape, group count, per-group
input/output channel counts, scalar multiply/add counts,
`host_uses_direct_grouped_loops=true`, `host_materializes_im2col=false`,
`cpu_fallback=false`, and the claim boundary
`grouped_conv2d_direct_scalar_smoke_only_not_vector_grouped_conv_or_production_compiler_backend`.

This proves direct grouped-Conv2D runtime orchestration over the current scalar
ABI. It is not a vector grouped-convolution datapath or general convolution
compiler: depthwise fallback, SAME padding, strided/dilated grouped
convolution, fused activation, Android delegation, and production compiler
backend support remain future work.

`lower_attention_qk_smoke` adds a tiny transformer-score evidence path for
rank-4 `[batch][heads][tokens][head_dim]` query/key tensors. It accepts
`stablehlo.attention_qk`, `stablehlo.dot_general`, `tflite.batch_matmul`,
and `eliza.attention_qk`
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
`stablehlo.attention_av`, `stablehlo.dot_general`, `tflite.batch_matmul`,
and `eliza.attention_av`
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
query/key/value tensors, an optional boolean mask, and optional
`mask_mode=causal` or `mask_mode=sliding_window` host mask generation. The path calls
`lower_attention_qk_smoke`, requantizes QK scores to int8 logits on host,
generates causal or sliding-window masks on host when requested, calls
`lower_attention_softmax_smoke`, requantizes Q0.8 attention weights to int8,
calls `lower_attention_av_smoke`, and requantizes the context tensor. The
returned evidence records QK scores, logits, the attention mask, approximate
softmax weights, attention weights, AV context, requantized context, head count, tile count,
`computes_qk_scores=true`, `computes_attention_softmax=true`,
`requires_prequantized_attention=false`, `host_generates_causal_mask=true` when
the causal mode is used, `host_generates_sliding_window_mask=true` when the
sliding-window mode is used, `host_requantizes_qk_scores=true`,
`host_requantizes_attention_weights=true`, `host_requantizes_context=true`,
`cpu_fallback=false`, and the claim boundary
`multihead_attention_qk_exp2_softmax_av_smoke_only_not_fused_flash_attention_or_production_compiler_backend`.

This proves multi-head attention runtime orchestration over current smoke
primitives only. It is not fused flash attention, exact exp/e softmax, scaling
fusion, causal-mask hardware, sliding-window sparse attention hardware,
KV-cache paging/update, graph partitioning, Android delegation, a production
compiler backend, or sustained transformer decode evidence.

`lower_qkv_projection_smoke` adds a packed transformer-projection evidence path
for `eliza.qkv_projection`, `stablehlo.qkv_projection`, and
`tflite.qkv_projection` records. It accepts an int8 input matrix and a packed
int8 `[Q|K|V]` weight matrix whose Q, K, and V output widths match the model
dimension. The NPU runs the packed projection through one `lower_matmul_smoke`
GEMM path, then host code slices the packed accumulator into Q/K/V matrices and
requantizes each output. The returned evidence records the packed accumulator,
Q/K/V accumulators, requantized Q/K/V tensors, nested matmul evidence, tile
count, `host_slices_packed_qkv=true`, `host_requantizes_qkv=true`,
`cpu_fallback=false`, and the claim boundary
`qkv_projection_packed_gemm_smoke_only_not_fused_attention_or_production_compiler_backend`.

This proves packed-QKV projection runtime orchestration only. It is not fused
attention, fused RoPE, KV-cache update, a multi-head layout scheduler, graph
compiler path, Android delegation, or a production transformer projection
kernel.

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
cache-view up to the maximum updated head length or an optional recent-token
`cache_window`, masks padded cache lanes, and calls `lower_attention_smoke` so
QK-softmax-AV runs over the updated cache. The returned evidence records the K/V
cache update result, cache-view tensors, attention mask, updated cache lengths,
maximum attention cache length, `updates_kv_cache=true`,
`computes_attention_over_cache=true`, `host_materializes_cache_view=true`,
`host_applies_decode_cache_window=true` when a recent-token decode window is
used, `cpu_fallback=false`, and the claim boundary
`decode_attention_kv_append_qk_softmax_av_smoke_only_not_paged_cache_flash_attention_or_production_compiler_backend`.

This proves decode-attention runtime orchestration only. It is not a paged KV
cache, hardware cache eviction policy, circular buffer, DMA-backed cache update,
fused flash attention, multi-batch cache manager, Android delegation, graph
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
The StableHLO import planner maps checked `stablehlo.mlp` records to this smoke
schema, materializes the static ReLU activation and default requantization shift,
and dispatches through `lower_stablehlo_module_smoke` without CPU fallback.

This proves transformer-MLP ReLU runtime orchestration over the current bounded
GEMM and VRELU ABIs. It is not a production feed-forward compiler path:
GELU/SwiGLU inside `lower_mlp_smoke`, fused bias add, fused residual add,
normalization, activation fusion, graph partitioning, Android delegation, and
hardware scheduling remain future work.

`lower_swiglu_smoke` adds gated transformer-MLP evidence paths for
`eliza.swiglu`, `eliza.gated_mlp`, `stablehlo.swiglu`, and `tflite.swiglu`
records. It accepts int8 inputs, up-projection weights, gate-projection
weights, and down-projection weights. The NPU runs up and gate projection MACs
through `GEMM_S8`. The `linear_gate` path executes every elementwise gate
product through scalar `OP_MUL_LO`; the `silu` path first routes the requantized
gate tensor through `lower_silu_smoke`, then executes every
`up * SiLU(gate)` product through scalar `OP_MUL_LO`. Host code applies the
fixed-point gate shift and int8 saturation before the down projection runs
through `GEMM_S8`. The returned evidence records up/gate accumulators,
requantized hidden tensors, activated gate tensors, nested SiLU evidence when
used, gated hidden tensor, nested matmul evidence, scalar multiply count,
`cpu_fallback=false`, and either
`swiglu_s8_scalar_gate_smoke_only_not_silu_or_production_compiler_backend` or
`swiglu_s8_silu_gate_smoke_only_not_fused_vector_swiglu_or_production_compiler_backend`.

This proves gated-MLP scalar runtime orchestration, including a scalar SiLU-gated SwiGLU smoke path.
It is not an exact sigmoid implementation, vector gate datapath, fused SwiGLU
kernel, graph compiler path, Android delegation, or production transformer MLP
kernel.

`lower_silu_smoke` adds a tiny scalar SiLU-approximation evidence path for
`stablehlo.silu`, `tflite.silu`, `eliza.silu`, and `eliza.approx_silu`
records. It accepts signed int8 matrix inputs and the
`exp2_q0_8_piecewise` approximation. The NPU dispatches each sigmoid-decay
approximation through `EXP2_NEG_Q0_8`, reconstructs the nonnegative branch with
`OP_SUB`, and dispatches every `x * sigmoid(x)` product through `OP_MUL_LO`;
host code applies the final Q0.8 shift and int8 saturation. The returned
evidence records the approximated Q0.8 sigmoid gates, output matrix, scalar
EXP2/SUB/MUL counts, `host_applies_shift_and_saturation=true`,
`cpu_fallback=false`, and the claim boundary
`silu_s8_exp2_piecewise_smoke_only_not_exact_sigmoid_or_vector_activation`.

This proves scalar SiLU-approximation orchestration only. It is not exact
sigmoid/SiLU, a vector activation datapath, fused SwiGLU, graph compiler path,
Android delegation, or a production transformer activation kernel.

`lower_gelu_smoke` adds a tiny scalar QuickGELU-approximation evidence path for
`stablehlo.gelu`, `tflite.gelu`, `eliza.gelu`, and `eliza.quick_gelu` records.
It accepts signed int8 matrix inputs and the `quick_gelu_exp2_q0_8`
approximation. The NPU dispatches the fixed-point `1.703125 * x` scale through
`OP_MUL_LO`, dispatches each sigmoid-decay approximation through
`EXP2_NEG_Q0_8`, reconstructs the nonnegative branch with `OP_SUB`, and
dispatches every `x * sigmoid(1.703125 * x)` product through `OP_MUL_LO`; host
code applies the final Q0.8 shift and int8 saturation. The returned evidence
records scaled inputs, approximated Q0.8 sigmoid gates, output matrix, scalar
scale-MUL/EXP2/SUB/gate-MUL counts, `host_applies_shift_and_saturation=true`,
`cpu_fallback=false`, and the claim boundary
`gelu_s8_quick_exp2_piecewise_smoke_only_not_exact_gelu_or_vector_activation`.

This proves scalar QuickGELU-approximation orchestration only. It is not exact
erf/tanh GELU, exact sigmoid, a vector activation datapath, fused MLP
activation, graph compiler path, Android delegation, or a production
transformer activation kernel.

`lower_bias_add_smoke` adds a tiny int8 row-wise bias-add evidence path for
`stablehlo.add`, `stablehlo.bias_add`, `tflite.add`, and `eliza.bias_add` matrix
records. Host code validates the bias width, broadcasts the bias vector over
input rows, and the NPU executes each elementwise add through scalar `OP_ADD`;
host code interprets the signed int32 result and saturates it to int8. The
returned evidence records input shape, bias shape, element count, scalar add count,
`host_broadcasts_bias=true`, `host_saturates_int8=true`, `cpu_fallback=false`,
and the claim boundary
`bias_add_s8_scalar_broadcast_smoke_only_not_vector_or_production_compiler_backend`.
The StableHLO import planner maps checked `stablehlo.bias_add` records to this
smoke schema and dispatches them through `lower_stablehlo_module_smoke`.

This proves row-wise bias-add scalar broadcast orchestration only. It is not a
vector add datapath or fused projection bias path: arbitrary-rank broadcasting,
normalization, graph partitioning, Android delegation, and hardware scheduling
remain future work.

`lower_residual_add_smoke` adds a tiny int8 residual-add evidence path for
`stablehlo.add`, `stablehlo.residual_add`, `tflite.add`, and `eliza.residual_add`
matrix records. Host code validates equal shapes before MMIO. The NPU executes
each elementwise add through scalar `OP_ADD`; host code interprets the signed
int32 result and saturates it to int8. The returned evidence records the output
shape, element count, scalar add count, `host_saturates_int8=true`,
`cpu_fallback=false`, and the claim boundary
`residual_add_s8_scalar_smoke_only_not_vector_or_production_compiler_backend`.
The StableHLO import planner maps checked `stablehlo.add` and
`stablehlo.residual_add` records to this smoke schema and dispatches them
through `lower_stablehlo_module_smoke`.

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
an optional packed `[Q|K|V]` projection weight, an optional boolean attention
mask, rotary cosine/sine tables, row-wise attention bias, SwiGLU weights, and
an optional `swiglu_activation` selector, and optional
`attention_mask_mode=causal` or `attention_mask_mode=sliding_window` host mask
generation.
The path calls `lower_rmsnorm_smoke`, then either three `lower_matmul_smoke`
Q/K/V projections or one `lower_qkv_projection_smoke` packed projection with
host Q/K/V slicing, host Q/K/V requantization, `lower_rope_smoke` for Q and K,
`lower_attention_qk_smoke`, host QK-score requantization,
optional host causal or sliding-window mask generation,
`lower_attention_softmax_smoke`, host Q0.8 attention-weight requantization, `lower_attention_av_smoke`,
`lower_bias_add_smoke`, `lower_residual_add_smoke`, a second
`lower_rmsnorm_smoke`, `lower_swiglu_smoke` with optional SiLU-gated SwiGLU,
and a final `lower_residual_add_smoke`. The returned evidence records normalized tensors,
separate or packed Q/K/V projection evidence, RoPE outputs, QK scores,
requantized QK logits, approximate softmax weights, requantized attention
weights, attention context, residuals, SwiGLU output, final output, total GEMM
tile count, scalar arithmetic counts, `computes_qk_scores=true`,
`computes_attention_softmax=true`, `requires_prequantized_attention=false`,
`host_generates_causal_mask=true` when causal mode is used,
`host_generates_sliding_window_mask=true` when sliding-window mode is used,
`host_slices_packed_qkv=true` when the packed path is used,
`swiglu.gate_activation_result` when the SiLU-gated path is used,
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
| `0x30` | `CMD_PARAM` | bit 0 selects descriptor-submission mode; bit 1 selects BitNet ternary decode for the next `DOT16_S2` dispatch |
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
| `0x74` | `PERF_STALL_CYCLES` | cycles the descriptor engine spent in an AXI memory-wait state (descriptor fetch, tensor stream, or writeback) regardless of handshake completion |
| `0x78` | `PERF_SCRATCH_BYTES` | scratchpad bytes accessed (read plus write) by accepted GEMM, VRELU, descriptor stream, and writeback paths |
| `0x7c` | `PERF_THERMAL_THROTTLE` | simulation-only host-writable shadow latch; each MMIO write increments by one. Real thermal HAL evidence will replace the host writes when it exists |
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

### DMA writeback path (planned, L1)

The current RTL writeback master only serves the streamed GEMM case described
above. Generalising the writeback path is an L1 deliverable; this section is
spec-only and no RTL exists for the items below. When the writeback path
lands, the descriptor engine must:

- Accept `writeback_request[30]=1` for every opcode that produces a scratchpad
  result tile, not only `OP_GEMM_S8`/`OP_GEMM_S4`. The current `desc_writeback_cfg_ok`
  check rejects scalar and vector writebacks; that gate widens once the source
  range and byte count are derived from the opcode in the same way as the
  streamed GEMM tile.
- Drive the existing NPU AXI-Lite write master (`m_axil_aw*`, `m_axil_w*`,
  `m_axil_b*`) through `DESC_WRITE_ADDR`/`DESC_WRITE_RESP`. The transactions
  remain word-aligned and word-sized; unaligned destinations, partial-word
  writes, and burst transactions stay rejected with `DESC_STATUS[7]` (malformed
  writeback request).
- Maintain ordering between the source operation completing (`desc_engine_done`)
  and the writeback issuing. The descriptor engine already enforces this through
  the `DESC_WAIT` → `DESC_WRITE_ADDR` transition; the new opcodes plug into the
  same handshake.
- Update `DESC_BYTES_WRITTEN`, `DESC_WRITE_BEATS`, and `PERF_SCRATCH_BYTES`
  on every accepted beat so that `dma_trace_bytes_written` and
  `perf_counter_dma_bytes_written` become non-zero for the affected opcodes.
- Surface AXI write-response errors through `DESC_STATUS[4]`/`DESC_STATUS[7]`
  and `PERF_ERRORS`, identical to the current streamed GEMM behavior.

Descriptor word format additions stay backward compatible: word 2 continues
to carry the aligned writeback destination byte address, word 3 stays reserved
for the writeback length expressed in bytes (currently derived implicitly from
the GEMM tile shape). The contract update gating L1 progression is tracked in
`docs/spec-db/npu-2028-roadmap.yaml` under `L1_DESCRIPTOR_DMA_RUNTIME`. Until
this RTL lands, scalar writeback, vector writeback, unaligned destinations,
and non-word-sized writebacks remain fail-closed at submit time.

The userspace runtime exposes a `CommandBuffer` batching layer over the same
descriptor ABI. It accepts up to seven `NpuStreamDescriptor` entries, produces a
deterministic word-addressed `descriptor_image`, can stage that image through a
caller-provided 32-bit memory writer, then calls `submit` to arm
`DESC_BASE`/`DESC_HEAD`/`DESC_TAIL` once and wait for a single descriptor
completion proof. The runtime helper `stage_host_runtime_sequence` also replays
the prepared-batch `host_runtime_sequence` through caller-provided MMIO and
descriptor-memory writers and returns
`eliza.e1_npu_host_runtime_sequence_stage_result.v1` without polling or
executing. A userspace simulator smoke test now feeds the partitioner-produced
prepared batch into that helper, stages the descriptor image, writes the MMIO
sequence, and observes descriptor completion/counters in `E1NpuMmioSim`. The
simulator parses staged descriptor memory when present, checks the owner bit and
writeback constraints, and accounts descriptor fetch, tensor-stream read, and
GEMM writeback bytes. This is command-buffer staging evidence only; dependency
scheduling, coherent IOMMU staging, production DMA allocation, Android delegate
command streams, and deeper queue-depth proofs remain blocked.

The StableHLO subset partitioner now reports `command_buffer_batches` for
contiguous supported op runs. Each batch records ordered op names, runtime APIs,
descriptor slot count, and `CommandBuffer.MAX_ENTRIES`; supported runs are split
at the local seven-entry ring window and CPU-fallback entries terminate the
current batch. This is still partition-report evidence, not a dependency
scheduler, tensor lifetime allocator, memory planner, asynchronous queue owner,
or production compiler backend.

The prototype ExecuTorch and LiteRT delegate surfaces include those
`command_buffer_batches` in their JSON preprocess/invoke blobs alongside the
existing descriptor specs. This proves only that both delegate skeletons consume
the shared partitioner batching report; it is not native delegate codegen,
binary kernels, tensor memory allocation, Android NNAPI registration, or
production runtime integration.

The same preprocess blobs now include a metadata-only `tensor_arena_plan` with
deterministic 4-byte aligned tensor offsets, roles, shapes, logical dtypes,
`storage_dtype`, byte sizes, and total arena bytes. The arena is linear and
conservative so delegate tests can bind tensors to a stable staging contract
before a real allocator exists. Descriptor-backed INT8/INT4 matmul result
allocations keep the StableHLO logical dtype but use `int32_accumulator` storage
so the current RTL GEMM writeback tile has enough arena space. This is not tensor
lifetime reuse, alias analysis, DMA placement, cache-coherent allocation,
Android buffer integration, or a production memory planner.

The partitioner also derives a metadata-only `runtime_binding_plan` from the
same arena and lowering plans. Each supported op records its runtime API,
schema, command-buffer batch index, input `required_graph_fields`, and result
binding with arena tensor name, role, shape, dtype, byte size, and offset. It
also records `descriptor_codegen_ready`, aggregate `ready_ops`/`blocked_ops`,
and `unresolved_inputs` when a lowering field such as sparse metadata or group
scale metadata has no arena allocation. The ExecuTorch and LiteRT prototype
blobs carry this plan so descriptor staging can be tested against stable tensor
offsets without silently dropping required fields. This is not binary descriptor
codegen, DMA address assignment, tensor lifetime reuse, dependency scheduling,
Android delegate integration, or a production compiler backend.

For ops whose required fields are resolved, the partitioner now derives a
metadata-only `descriptor_staging_plan`. The plan records the current RTL
descriptor opcode, whether the input arena span can be streamed into the
64-byte scratchpad, the source arena offset, stream byte count, per-input
scratch offsets, output scratch offset, required writeback bytes, and the GEMM
MMIO preamble (`GEMM_CFG`, `GEMM_BASE`, `GEMM_STRIDE`). It also keeps
`blocking_reasons` when full descriptor codegen is not valid. With
`int32_accumulator` result storage, bounded INT8/INT4 matmul inputs can form a
descriptor input stream and the output can be represented as a current-RTL GEMM
writeback target. Ready entries now include a relocatable
`descriptor_word_template`: word0 is the concrete packed RTL descriptor control
word, word1 is `arena_base + source_arena_offset`, word2 is `arena_base +
output_arena_offset`, and word3 is zero; the Python object can materialize
`descriptor_words(arena_base)` fail-closed for aligned arena bases. At the plan
level, `command_buffer_image(arena_base, descriptor_base, batch_index)` builds
the same word-addressed descriptor image and submission tuple that
`CommandBuffer.descriptor_image()` expects, but only when every op in the batch
is descriptor-codegen ready. The same blob includes `descriptor_batches`, a
batch-level readiness summary with blocked op names and reasons, so delegates
can reject a mixed command-buffer batch before trying to emit descriptors.
ExecuTorch exposes this through `descriptor_command_buffer_image`, and LiteRT
mirrors it through `e1_litert_delegate_descriptor_command_buffer_image`, both
returning the same `eliza.e1_npu_descriptor_command_buffer_image.v1` shape for
ready batches and failing closed for mixed batches. The partition report also
exposes `prepared_descriptor_batch(arena_base, descriptor_base, batch_index)`,
which packages the tensor arena size/alignment, per-op GEMM MMIO preamble, and
descriptor command-buffer image under
`eliza.e1_npu_prepared_descriptor_batch.v1`; ExecuTorch mirrors this as
`prepared_descriptor_batch`, and LiteRT mirrors it as
`e1_litert_delegate_prepared_descriptor_batch`. The prepared batch also emits a
metadata-only `host_runtime_sequence` (`eliza.e1_npu_host_runtime_sequence.v1`)
that spells out the GEMM preamble writes, descriptor-memory staging writes,
descriptor submission MMIO writes, and `DESC_STATUS` completion-poll condition.
Non-matmul ops and unresolved sparse/group-scale metadata remain blocked. This
does not assign an arena base, populate tensor data, own DMA submission, perform
output dtype conversion, integrate an Android delegate, or replace the
production compiler backend.

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
