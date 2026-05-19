# 2028 NPU Target

This is the Eliza performance target for a best-in-class 2028 Android
phone NPU. It is intentionally higher than the current `e1_npu` RTL, which
remains an L0 unit demonstrator. The target is used to steer architecture,
verification, compiler, Android HAL, and benchmark work without pretending the
current repo has phone-class silicon.

## Current Public Signals

The 2026 public SOTA direction is clear:

| Anchor | Public signal | Design consequence |
| --- | --- | --- |
| Qualcomm Snapdragon 8 Elite Gen 5 | Hexagon NPU is advertised as 37% faster, 16% better performance per watt, with INT2 and FP8 support. | Low precision and mixed precision must be first-class, not a later extension. |
| MediaTek Dimensity 9500 | NPU 990 claims up to 56% lower peak power, over 2x token-generation speed, and a CIM-based efficient NPU. | Data movement dominates. SRAM locality, compression, sparsity, and always-on efficiency matter as much as MAC count. |
| Samsung Exynos 2600 | NPU claims 113% better generative-AI performance with lower latency and power plus ExecuTorch support. | The software stack must target real model deployment paths, not only synthetic GEMM. |
| Qualcomm Snapdragon X2 family | Laptop-class integrated NPU listings show 80 TOPS and 152 GB/s LPDDR5x bandwidth. | A large-battery phone should target laptop-adjacent burst AI while enforcing mobile sustained-power gates. |
| Apple A19 Pro | A 16-core Neural Engine is paired with GPU Neural Accelerators. | The AP should expose cooperative GPU/NPU scheduling for graphics-plus-AI workloads. |

Current runtime evidence includes host-generated causal and sliding-window
prefill masks plus recent-token decode cache-window materialization, so
long-context transformer work can be tested without claiming paged KV cache or
flash-attention hardware.

Sources are recorded in
`docs/spec-db/npu-2028-target.yaml`.

## Numeric Target

The target is not a marketing TOPS target. TOPS must be reported with
precision, sparsity, thermal state, clock, power, memory bandwidth, and CPU
fallback percentage.

| Metric | 2028 target |
| --- | ---: |
| Dense INT8 peak | at least 160 TOPS |
| Dense INT8 sustained | at least 80 TOPS |
| Sparse INT4 peak | at least 512 TOPS |
| Sparse INT4 sustained | at least 200 TOPS |
| INT2 / BitNet-class peak | at least 900 TOPS |
| FP8 peak | at least 80 TFLOPS |
| Sustained INT8 efficiency | at least 18 TOPS/W |
| NPU burst power | no more than 8 W |
| NPU sustained power | no more than 4.5 W |
| Local SRAM | at least 64 MiB |
| Local SRAM bandwidth | at least 20 TB/s aggregate |
| Shared system cache | at least 32 MiB |
| External memory bandwidth | at least 180 GB/s |
| CPU fallback | no more than 1% of measured graph nodes |

## Architecture Direction

The 2028 NPU should be a tiled matrix/vector accelerator:

- 8 to 16 compute tiles.
- At least 4096 INT8 MAC units per tile, with INT4/INT2 packing paths.
- At least 4 MiB local SRAM per tile.
- Separate systolic matrix, vector activation, layout-transform, DMA, sparsity
  decode, and scalar-control engines.
- IOMMU-isolated command buffers, deep queues, per-context fault isolation, and
  cache-coherent CPU submission.
- Hardware support for transformer decode, prefill, convolution, camera AI,
  image generation, and always-on micro-NPU paths.

## Software Direction

The NPU is only real when the software stack can use it:

- AIDL HAL and fail-closed SELinux policy.
- TFLite delegate and NNAPI or successor runtime integration.
- StableHLO import through an MLIR pipeline.
- IREE or TVM backend for repeatable lowering.
- ExecuTorch/PyTorch export path for on-device model deployment.
- Benchmark evidence with unsupported-op count, CPU fallback percentage, power
  traces, thermal traces, and exact model hashes.

## Current Repo Gap

`rtl/npu/e1_npu.sv` is currently a scalar datapath plus a 64-byte scratchpad
GEMM prototype. It now includes packed INT4, INT2, scalar FP8, descriptor read
streaming into scratchpad, and a streamed `GEMM_S8` descriptor writeback smoke
path. The userspace runtime also has a `CommandBuffer` descriptor-batching
abstraction with deterministic descriptor-image staging and single-completion
submit, but this remains bounded RTL/runtime evidence rather than a tensor
command processor. The StableHLO subset partitioner reports contiguous
`command_buffer_batches` for supported op runs and splits them at the local
seven-entry ring window, but it still does not provide dependency scheduling or
memory planning. The prototype ExecuTorch and LiteRT delegate blobs now carry
those batches alongside descriptor specs, but they are still metadata-only
skeletons rather than binary kernels or Android delegate integration. The same
blobs include a linear `tensor_arena_plan` with deterministic 4-byte aligned
offsets and byte sizes, but this is not lifetime reuse, DMA placement, or a
production memory planner. They also include a metadata-only
`runtime_binding_plan` that maps lowering `required_graph_fields` and result
tensors to arena offsets and command-buffer batch indexes. The plan now marks
`descriptor_codegen_ready` ops and records `unresolved_inputs` for required
sparse/group-scale metadata that is not yet represented in the arena, but this
is not DMA address assignment, binary descriptor codegen, dependency scheduling,
or Android delegate integration. A new `descriptor_staging_plan` derives the
current RTL opcode, input stream span, scratch offsets, output scratch offset,
and GEMM MMIO preamble for ready matmul bindings; it still blocks full
descriptor codegen when writeback storage is not sized for the RTL int32 GEMM
accumulator tile. The runtime lowering evidence now includes bounded INT8/INT4 matmul,
scalar-dot sparse INT4 2:4, scalar Q8.8 group-scaled INT4, INT2, FP8 E4M3,
and scalar Q8.8 FP16/BF16 matmul, im2col Conv2D, direct depthwise/grouped Conv2D, attention
QK/softmax/AV plus composed multi-head attention with host-generated causal and
sliding-window masks, append-only KV-cache update, packed-QKV projection, decode attention over
the updated cache, RoPE, RMSNorm, SwiGLU, scalar SiLU/GELU approximation,
scalar SiLU-gated SwiGLU, and a single-head modern decoder-block smoke path
with explicit non-production compiler boundaries. The checked StableHLO subset
accepts bounded rank-2 `stablehlo.dot_general` and `stablehlo.dot` records for
those low-precision matmul smoke modes and emits parser-only `LoweringPlan`
records plus checked smoke graph materialization for the matching runtime smoke
APIs. `lower_stablehlo_module_smoke` dispatches those materialized records
through the covered smoke lowerers without CPU fallback and records
`dispatch_order`, `lowering_plans`, and `all_npu_dispatch` metadata while
rejecting empty modules and duplicate op names before lowering. The same path
now accepts bounded INT8/INT4 rank-4 `stablehlo.batch_matmul` records and
dispatches them through `lower_batch_matmul_smoke`, which host-iterates
batch/head slices and reuses the tiled matmul smoke lowerer without CPU
fallback. It also maps checked INT8/INT4 batch-1 NHWC/HWIO
`stablehlo.convolution` records into `lower_conv2d_smoke`, preserving the static
VALID/stride-1/dilation-1 attributes and dispatching im2col-backed GEMM without
CPU fallback. Checked INT8 `stablehlo.add`, `stablehlo.residual_add`, and
`stablehlo.bias_add` records are also materialized into scalar OP_ADD-backed
residual/bias smoke lowerers without CPU fallback. Checked INT8 ReLU
`stablehlo.mlp` records are materialized into `lower_mlp_smoke`, which dispatches
GEMM/VRELU/GEMM through the existing smoke ABIs without CPU fallback. Checked
INT8/INT4 rank-4 `stablehlo.attention_qk` and `stablehlo.attention_av` records
are materialized into `lower_attention_qk_smoke` and
`lower_attention_av_smoke`, preserving the existing split QK/AV smoke
boundaries without claiming fused attention or production compiler coverage. The
design is still missing the actual tensor NPU structure:

- no tensor command queue,
- no production DMA-fed scratchpad or coherent tensor memory system,
- no large SRAM,
- no systolic array,
- no sparse INT4 GEMM,
- no INT2, FP8, FP16, or BF16 tensor execution,
- no compiler backend,
- no Android accelerator delegate,
- no measured area or power model,
- no sustained hardware benchmark evidence.

The deterministic scale model now reports cycle, memory, energy, and TOPS/W
estimates for open 2028 targets, including a modeled SOTA point above 160 dense
INT8 TOPS and 18 TOPS/W on a large GEMM. That is planning evidence only. The
next implementation move remains replacing the scalar GEMM prototype with a
parameterized INT8/INT4 tile RTL model and proving it through descriptor-fed
runtime tests.

## Evidence Gate

The current repository must stay classified as `L0_RTL_UNIT` for NPU capability
until a target report supplies all of the following:

| Evidence | Required content |
| --- | --- |
| TOPS/MAC counters | `macs_per_inference`, `npu_cycles`, `npu_hz`, `observed_tops`, and `tops_formula` derived from hardware counters |
| Precision | Actual delegate precision such as INT8, INT4, INT2, FP8, BF16, or FP16 |
| Dataflow | Named measured dataflow path, not only a GEMM math estimate |
| Descriptor queue | Queue depth, descriptor head/tail completion, timeout/error behavior, and host runtime submission proof |
| DMA | Hardware tensor-streaming DMA path and bytes read/written by the NPU workload |
| Runtime counters | Cycles, MACs, ops, errors, unsupported ops, DMA read bytes, and DMA written bytes from the measured path |
| Android HAL / NNAPI | AIDL HAL service proof, fail-closed SELinux policy, VTS/CTS results, `e1-npu` accelerator query, total/delegated node counts, zero CPU fallback, and zero unsupported ops |
| Model binding | Exact model SHA-256 and transcript hashes |
| Power/thermal | Calibrated power trace, thermal trace, frequency trace, calibration record, throttle state, and perf/W calculation with exact SHA-256 values |

The Android gate starts from
`docs/benchmarks/capabilities/e1_npu_android_proof_manifest.template.json`.
It stays blocked until an external AOSP validation job fills real HAL, VINTF,
SELinux, VTS, CTS, NNAPI query, and absent-device fail-closed artifacts with
matching hashes. The sustained efficiency gate starts from
`docs/benchmarks/capabilities/e1_npu_power_thermal_manifest.template.json`
and stays blocked until calibrated trace artifacts exist.

For review, TOPS is bounded by the counter evidence:

```text
observed_tops <= macs_per_inference * 2 / (npu_cycles / npu_hz) / 1e12
```

The scalar RTL cannot produce phone-class TOPS, sustained power, or Android
delegate evidence. Passing `scripts/check_npu_2028_targets.py` means the repo
keeps this distinction explicit; it does not mean the 2028 target is met.

## Next Commands

```sh
python3 scripts/check_npu_2028_targets.py
python3 scripts/check_platform_contract.py
python3 benchmarks/run_benchmarks.py plan --bench tflite_e1_npu --strict-missing
make npu-2028-target-check platform-contract-check
```
