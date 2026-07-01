# E1 AI Optimization Plan

Date: 2026-05-19

## Goal

Move E1 from a small MMIO tensor-smoke scaffold toward a credible mobile AI SoC
architecture with evidence-backed progress toward transformer inference,
sustained performance per watt, and future 14A/sub-2 nm feasibility.

## Current Local Baseline

The repository already has a useful start:

- bounded MMIO NPU runtime,
- INT8 GEMM smoke,
- packed INT4 GEMM smoke,
- sparse INT4 dot smoke,
- FP8 E4M3 scalar dot smoke,
- descriptor-stream scaffolding,
- transformer MLP and single-head transformer-block smoke lowering,
- NPU 2028 phase-gate and target specs.

The large gaps are also explicit:

- no DMA-fed scratchpad,
- no large banked local SRAM,
- no real systolic/tensor array,
- no production compiler backend,
- no softmax/norm/GELU/SiLU/rotary/KV-cache path,
- no cycle/energy model tied to RTL parameters,
- no Linux/Android delegate evidence for real models,
- no process-node-backed TOPS/W evidence.

## Priority 0: Evidence Discipline

1. Add `research/ai_accelerator_sota` to the source inventory checks.
2. Ensure every NPU feature has:
   - spec-db entry,
   - RTL or runtime implementation,
   - simulator/golden test,
   - Linux UAPI or explicit blocked gate,
   - performance/energy claim boundary.
3. Extend `scripts/check_npu_2028_targets.py` so SOTA features cannot be marked
   implemented unless tests and docs exist.

## Priority 1: DMA-Fed Tensor Tile

Implement next:

- descriptor ring with memory-to-scratchpad DMA,
- banked scratchpad with double buffering,
- parameterized tile dimensions,
- runtime capability query generated from one config,
- cycle counter for load, compute, store, and stall cycles.

Why: every SOTA source points to memory movement as the limiter. The current
64-byte MMIO scratchpad proves semantics but cannot support sustained ML claims.

Acceptance gates:

- cocotb test for descriptor DMA load/compute/store,
- runtime test for tiled GEMM without CPU fallback,
- negative test for malformed descriptors before state mutation,
- cycle model versus RTL-sim event counts,
- docs/spec-db contract update.

## Priority 2: Real INT8/INT4 Systolic Array

Implement a small parameterized systolic array before adding exotic precision.

Features:

- INT8 MAC path with int32 accumulation,
- INT4 packed MAC path with shared unpack/decode,
- output-stationary and weight-stationary mode hooks,
- accumulator SRAM,
- saturation/requantization unit,
- array utilization counters.

Target first shape: a tiny 4x4 or 8x8 tile suitable for Verilator/cocotb and
FPGA growth. The generator should later scale to 16x16, 32x32, or larger arrays.

Acceptance gates:

- randomized GEMM equivalence tests,
- tile-boundary tests for ragged M/N/K,
- utilization counter tests,
- lint/formal smoke,
- runtime lowering for split-K and multi-tile accumulation.

## Priority 3: Transformer Primitive Set

Add hardware/runtime support in this order:

1. RMSNorm / LayerNorm reduction primitive.
2. GELU and SiLU/SwiGLU activation paths.
3. Softmax approximation with max/sub/exp/sum/div stages or a documented
   LUT/piecewise approximation.
4. Rotary embedding and position transform.
5. KV-cache load/store/update primitive.
6. QK and AV attention lowering with masking and scaling.
7. Fused transformer block with no host-side math in the hot path.

Why: Snapdragon, Dimensity, Blackwell, and Ironwood all target agentic,
reasoning, MoE, diffusion, and transformer workloads. Matmul-only hardware is
not enough.

Acceptance gates:

- tiny attention block golden tests,
- TFLite/StableHLO/IREE-style graph lowering smoke,
- no CPU fallback in claimed region,
- numerical tolerance documented per precision,
- Linux userspace smoke for a toy transformer layer.

## Priority 4: Low Precision Phase-In

Implement precision in stages:

- Stage A: finish INT4 tensor path and structured sparsity.
- Stage B: add FP8 E4M3/E5M2 tensor GEMM, not just scalar dot.
- Stage C: add block floating point / microscaling metadata.
- Stage D: add FP4/NVFP4-like experimental path behind a blocked production
  claim gate.
- Stage E: add INT2 only where model-quality evidence exists.

Do not expose a precision as production-ready until there is a compiler lowering
and model-level accuracy/performance evidence.

Acceptance gates:

- per-precision golden reference,
- overflow/saturation tests,
- per-channel/per-block scale metadata ABI,
- model smoke with accuracy delta recorded,
- TOPS/W model including metadata overhead.

## Priority 5: Sparsity, Embeddings, And MoE

Implement:

- 2:4 structured sparsity decode for INT4 weights,
- block-sparse GEMM metadata format,
- embedding gather/scatter side unit,
- MoE top-k routing metadata path,
- compressed weight decompression path.

Why: TPU v4 SparseCore, Blackwell MoE positioning, and mobile agentic workloads
all point to sparse and embedding-heavy inference.

Acceptance gates:

- sparse metadata validation,
- dense-vs-sparse equivalence tests,
- utilization counters that include metadata stalls,
- embedding table microbenchmark,
- MoE toy model smoke.

## Priority 6: Memory Hierarchy And Bandwidth

Design targets:

- banked local SRAM sized by model/tile study,
- DMA prefetch with double or triple buffering,
- CPU/NPU shared-memory ABI,
- optional cache-coherent path only if the SoC interconnect contract supports it,
- LPDDR bandwidth model for mobile package,
- future HBM/UCIe package model as a separate target.

Metrics to add:

- bytes/MAC,
- bytes/token,
- SRAM bank conflict rate,
- DMA stall percentage,
- achieved TOPS under bandwidth cap,
- tokens/J estimate.

## Priority 7: Power, Thermal, And 14A/Sub-2 nm Readiness

Add models before making advanced-node claims:

- process manifest for current FPGA/sky130/proxy and future 14A targets,
- NPU dynamic power proxy by operation,
- local thermal density proxy,
- IR-drop budget placeholder,
- SRAM Vmin/ECC/repair plan,
- aging derate plan,
- package thermal envelope for phone and server/prototype variants.

14A-specific architectural choices:

- use smaller replicated tiles rather than one huge array,
- place SRAM banks close to compute,
- reserve power/thermal telemetry and DVFS hooks,
- plan chiplet split if die area or yield exceeds monolithic assumptions,
- keep HBM-class package assumptions separate from mobile LPDDR assumptions.

## Priority 8: Software Stack

Implement:

- stable Linux UAPI for descriptors and buffers,
- userspace runtime library,
- Buildroot smoke app for real tensor descriptors,
- Android HAL/NNAPI absence-or-presence evidence,
- IREE or MLIR lowering experiment for matmul/attention/MLP,
- model importer for tiny Llama/ViT/DiT smoke graphs.

Every graph lowering must declare whether host-side math remains in the claimed
region.

## Priority 9: Benchmarking

Add benchmark families:

- GEMM roofline: INT8, INT4, sparse INT4, FP8.
- Transformer layer: prefill and decode.
- KV-cache bandwidth.
- Tiny Llama block.
- Tiny diffusion transformer block.
- Embedding/MoE microbench.
- Sustained thermal loop.

Output metrics:

- peak and sustained TOPS,
- tokens/s and tokens/J,
- memory bandwidth utilization,
- NPU utilization,
- CPU fallback percentage,
- energy estimate with source assumptions.

## Ranked Implementation Backlog

1. Descriptor DMA and banked scratchpad.
2. Parameterized INT8/INT4 systolic array RTL.
3. Cycle-accurate tile performance model.
4. Structured 2:4 sparse INT4 tensor GEMM.
5. Tensor FP8 E4M3/E5M2 GEMM.
6. Requantization, scaling, and block-scale metadata ABI.
7. RMSNorm/LayerNorm primitive.
8. GELU/SiLU/SwiGLU primitive.
9. Softmax approximation primitive.
10. Rotary embedding primitive.
11. KV-cache update/load/store path.
12. Fused attention lowering with mask/scale.
13. Fused transformer block lowering with no host math.
14. Embedding gather/scatter side unit.
15. MoE routing and block-sparse expert dispatch.
16. Decompression path for compressed weights.
17. Linux DMA buffer and descriptor UAPI.
18. Android/IREE/TFLite delegate smoke.
19. Thermal/power/IR-drop model tied to tile activity.
20. 14A/sub-2 nm process and package feasibility gate.

## Non-Goals Until Evidence Exists

- Claiming Blackwell-, Ironwood-, Snapdragon-, or Dimensity-class performance.
- Claiming 14A power/performance/density without PDK/library evidence.
- Claiming CIM without macro data.
- Claiming HBM bandwidth in a mobile package.
- Claiming production compiler support from smoke lowerings.

## Immediate Next Patch Recommendation

The next implementation patch should be `L1_DESCRIPTOR_DMA_RUNTIME`:

- create a checked descriptor ABI for tensor DMA,
- move GEMM input/output staging out of ad hoc MMIO writes,
- add a scratchpad-bank model,
- add runtime and cocotb tests,
- update `docs/spec-db/e1-npu-runtime-contract.json`,
- update the NPU 2028 phase-gate spec,
- keep every performance claim at smoke/prototype level until RTL timing exists.
