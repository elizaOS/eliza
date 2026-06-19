# Dataflow taxonomies, tiling, and compiler/runtime scheduling for E1

Date: 2026-05-19

This file connects the academic dataflow taxonomies to the E1 plan in
`docs/arch/npu-microarch.md`, specifically the descriptor ring + DMA
contract and the L2 / L3 tile structure.

## Canonical dataflows

The four reference dataflows that the literature has converged on:

| Dataflow | What stays in PE | When it wins | Reference |
| --- | --- | --- | --- |
| Weight stationary       | Weights         | weight-reuse-heavy (CNN, large MLP) | Gemmini default, NVDLA |
| Output stationary       | Partial sums    | output-reuse-heavy (small K)        | Gemmini configurable |
| Row stationary          | Row of weights and partial sums | balanced reuse across types | Eyeriss (`eyeriss_paper`) |
| No local reuse / TPU    | Nothing local; deep pipelined systolic | very large K           | TPU (`tpu_v4_paper`)   |

The E1 microarchitecture target lists `weight_stationary` and
`output_stationary` as required dataflows
(`microarchitecture_targets.dataflow`). That choice matches Gemmini's
configurable dataflow and TPU-style systolic operation. The omission of
row-stationary is deliberate: row-stationary makes sense for CNN-dominant
workloads, but E1's primary workload is transformer / attention, where
weight-stationary GEMM and output-stationary attention are the dominant
patterns.

## Dataflow flexibility vs static scheduling

There are two extreme design points in the literature:

1. **Static / compiler-determined dataflow.** Groq TSP (`groq_tsp_isca20`,
   `groq_tsp_atpesc`) compiles the entire program into deterministic
   producer-consumer streams. Hardware is functionally sliced; no
   runtime arbitration. Wins on latency and predictability. Loses on
   workload diversity and graph dynamism.
2. **Fully reconfigurable interconnect.** MAERI (`maeri_paper`) and SIGMA
   (`sigma_paper`) provide tiny switches that let the same fabric run
   weight-stationary, output-stationary, sparse, and irregular dataflows.
   Wins on workload diversity. Loses on per-cycle PE utilization and on
   verification effort.

The E1 plan is in between: a descriptor-driven, software-configurable
dataflow on top of a Gemmini-style array. The descriptor ring
(`docs/arch/npu-microarch.md`) gives software runtime control of
dataflow per descriptor, but the array itself is rigid. This matches the
mobile NPU consensus (Hexagon, ANE, NPU 990 all expose runtime
configuration via vendor compilers without committing to MAERI-class
reconfigurability).

## Hierarchical NoC and tile organization

For a multi-tile NPU (L3 onward), the connectivity choice matters as
much as the tile choice.

- **Eyeriss v2** (`eyeriss_v2_paper`) — hierarchical mesh NoC adapts to
  per-data-type bandwidth needs. Direct reference for E1's L3 tile
  fabric, especially the local SRAM bandwidth target of
  `local_sram_bandwidth_tbps_min: 20`.
- **Tenstorrent Blackhole** (`tenstorrent_blackhole_microbench`) — 140
  Tensix tiles with two NoC routers each; RISC-V baby cores as
  per-tile control. Validates the "small RISC-V core per tile +
  tensor engine" pattern at production scale.
- **Snitch cluster** (`snitch_cluster_repo`) — tightly-coupled RISC-V
  cluster with shared scratchpad. The smallest production-grade
  reference for a coherent tile.
- **Cerebras WSE-3** (`cerebras_wse3_comparison_paper`) — 21 PB/s on-chip
  SRAM bandwidth at the extreme. Reference for why on-chip bandwidth is
  the bottleneck even in a phone-scale design.

For E1, the most credible 2028 tile organization is:

- 8..16 Gemmini-derived tensor tiles, each with >=4 MiB local SRAM.
- A small RISC-V control core per tile (Snitch / baby-core scale) to
  handle descriptor dispatch and stream prefetch.
- A hierarchical mesh NoC for inter-tile data movement.
- A separate sparsity-decode microengine and an attention microengine
  shared across tiles (see `02_analysis/sparsity_and_attention.md`).

## Tile scheduling and the compiler/runtime seam

The hardware ABI is the contract between the compiler and the descriptor
ring. The literature gives strong evidence for these choices:

- **Per-descriptor flags including barrier and IRQ-on-complete** —
  matches NVDLA, Gemmini RoCC interface, and the existing
  `docs/arch/npu-microarch.md` flag set.
- **Software memory fence + doorbell write** — matches `vllm_paged_attention`
  expectations and the standard pattern used by Trainium2 (`trainium2_aws_docs`)
  and MTIA (`mtia_v2_isca25`).
- **CPU fallback path** — E1 already does this, and it is correct.
  Every production accelerator has either a CPU fallback or a
  graceful-degradation path; without it, an unsupported op silently
  drops latency to zero.
- **Compiler ownership of dataflow choice** — leave runtime dataflow
  reconfiguration to descriptor fields, not to in-hardware control.
  This matches Gemmini, NVDLA, MAERI, and TSP.

## Tensor compiler interface

The `npu-2028-target.software_targets.compiler` list cites MLIR,
StableHLO, TFLite, ExecuTorch/PyTorch, and IREE/TVM. The literature
specifically supports:

- **MLIR-based lowering** — IREE (`iree_repo`) and Torch-MLIR are the
  reference upstream stacks. Most modern compiler stacks for new
  accelerators converge here.
- **Two-level ISA** — VTA (`vta_blueprint_paper`) demonstrates that a
  micro-ISA below a tensor-level ISA gives the compiler hooks without
  forcing it into a fixed operator set. The E1 descriptor ring is
  effectively the tensor-level ISA; the scratchpad ops
  (`VRELU_S8`, etc.) act as the micro-ISA today.

The recommended compiler integration order:

1. Bring up an IREE backend that lowers StableHLO to the existing
   bounded GEMM + VRELU ops (L0 / L1).
2. Add an MLIR pass that pattern-matches transformer blocks and emits
   descriptor sequences for the L2 single tile.
3. Add a multi-tile scheduler in IREE (similar to the
   `RingAttention`-style block scheduling) for L3.
4. Add ExecuTorch and TFLite delegate adapters that target the same
   backend; do not maintain three independent backends. (L4)

## Memory and tiling strategy

Two key references for the tile scheduling math:

- **FlashAttention** (`flashattention_paper`) — the canonical proof that
  IO-aware tiling beats algorithmic optimization for attention.
- **FuseMax** (`fusemax_paper`) — generalizes the same idea via extended
  einsums and achieves seq-length-independent on-chip buffer use.

For GEMM, the math is the standard "fit M x K_chunk weight tile + N x
K_chunk activation tile + M x N output tile in SRAM" calculation. The
key constraint for E1: with ≥4 MiB SRAM per tile and >=8 tiles, the
working set per layer of a 7B INT4 model fits comfortably on chip for
typical sequence lengths up to ~4K tokens before KV cache becomes the
binding factor. KV cache management (paged attention, MLA, KV quant)
becomes the dominant scheduling problem above ~4K context.

## DMA contract

The L1 DMA gates in `npu-2028-roadmap.yaml` (DMA byte counters, DMA
streaming traces, perf counters) match the descriptor-DMA contract used
by NVDLA, Gemmini's RoCC interface, and MTIA v2's runtime
(`mtia_v2_isca25`). The current E1 DMA path streams into scratchpad but
has no writeback DMA; that is the next required step.

## Recommendations

High confidence:

- Keep the descriptor ring + per-descriptor flags ABI; do not rewrite it.
- Adopt IREE as the upstream compiler entry point and emit descriptors
  from a custom HAL backend.
- Plan for an 8..16-tile fabric with hierarchical mesh NoC, per-tile
  baby RISC-V control core, and shared sparsity-decode + attention
  microengines.
- Implement writeback DMA before any L4 evidence claim.

Medium confidence:

- Treat the scratchpad ops (`VRELU_S8`, future fused activation /
  requantize ops) as a stable micro-ISA. Don't promote one-off helper
  ops to the descriptor ring.

Lower confidence:

- Fully reconfigurable interconnect (MAERI-class) — not adopted; the
  area cost and verification burden are not justified at the E1
  workload profile.
- Static-only compilation (Groq-class) — not adopted; the workload
  diversity of an on-device phone NPU defeats the wins.
