# E1 NPU recommendations from the 2026 accelerator research packet

Date: 2026-05-19

This file ranks recommendations by confidence and links each to the
existing E1 spec docs, phase gates, and validation scripts. Nothing here
is a license to modify chip RTL, docs, or scripts; the
`packages/chip/CLAUDE.md` rules and the existing validation gates remain
authoritative. Every recommendation must run through normal review and
test before any spec or RTL change lands.

## Phase mapping

| Phase | Doc anchor | Key recommendations below |
| --- | --- | --- |
| L0_MMIO_PROTOTYPE (current) | `docs/arch/npu.md`, `rtl/npu/e1_npu.sv` | R-MX, R-INT4-GROUP, R-BITNET-TERN (spec only, no RTL yet) |
| L1_DESCRIPTOR_DMA_RUNTIME | `docs/arch/npu-microarch.md` descriptor ring | R-IOMMU, R-PAGED, R-WRITEBACK-DMA |
| L2_SINGLE_TILE_ACCELERATOR | `docs/arch/npu-microarch.md` Gemmini wrapper | R-GEMMINI-WRAP, R-MX, R-INT4-GROUP, R-2:4-TILE |
| L3_TILED_MULTI_CONTEXT_NPU | `docs/spec-db/npu-2028-target.yaml` numeric_targets | R-MESH-NOC, R-SPARSE-DECODE, R-ATTN-ENGINE |
| L4_ANDROID_HAL_DELEGATE | `docs/benchmarks/capabilities/e1_npu_android_proof_manifest.template.json` | R-IREE-BACKEND, R-EXECUTORCH-TFLITE |
| L5_2028_PHONE_CLASS_EVIDENCE | `docs/benchmarks/capabilities/e1_npu_power_thermal_manifest.template.json` | R-CIM-SLOT, R-THERMAL-AWARE |

## High-confidence recommendations

### R-MX: adopt OCP Microscaling formats as the FP family

- **Sources:** `ocp_mx_spec`, `mx_formats_paper`, `ocp_mx_blog`,
  `microxcaling_repo`, `ptq_mx_paper`, `nvidia_blackwell_architecture`,
  `blackwell_wikipedia`.
- **Anchor:** `docs/spec-db/npu-2028-target.yaml`
  `precision_requirements.required` includes `fp8` and `bf16`.
  Current `docs/arch/npu.md` exposes only `DOT4_FP8_E4M3` unscaled.
- **Recommendation:** replace flat FP8 with MXFP8 (E5M2 / E4M3 lanes,
  32-element blocks, E8M0 scale). Add MXFP6 and MXFP4 as L4 deliverables
  alongside MXINT8. Treat the existing `DOT4_FP8_E4M3` as scalar
  evidence only, not the production format.
- **Why high confidence:** OCP MX is a published standard backed by AMD,
  Arm, Intel, Meta, Microsoft, NVIDIA, and Qualcomm. Every shipping
  next-gen accelerator (NVIDIA Blackwell, TPU Ironwood roadmap)
  converges here. Inventing a parallel scaling scheme is strictly worse.

### R-INT4-GROUP: per-group INT4 weight scales

- **Sources:** `gptq_paper`, `awq_paper`, `omniquant_paper`, `hqq_repo`.
- **Anchor:** `docs/arch/npu.md` `GEMM_S4`.
- **Recommendation:** add group-scaled INT4 weights to the tile-level
  INT4 GEMM op (group sizes {32, 64, 128}). Storage layout: packed INT4
  weights + per-group INT8 or BF16 scale alongside.
- **Why high confidence:** the entire GPTQ / AWQ / OmniQuant / HQQ
  ecosystem of pretrained INT4 LLM checkpoints assumes group scales.
  Without it the E1 INT4 tier cannot run today's deployed INT4 models
  without lossy re-quantization.

### R-BITNET-TERN: ternary mode for INT2 path

- **Sources:** `bitnet_b1_58_paper`, `bitnet_a4_8_paper`, `bitnet_2b4t_hf`.
- **Anchor:** `docs/arch/npu.md` `DOT16_S2` (currently signed 2-bit
  two's complement in `[-2, 1]`).
- **Recommendation:** add a ternary `{-1, 0, +1}` mode either as a flag
  on `DOT16_S2` or as a new opcode. Ternary halves the activation
  multiplier energy because sign-flip + sum replaces multiply.
- **Why high confidence:** BitNet b1.58 / a4.8 is the only viable
  INT2-class path with public production-grade open weights
  (`bitnet_2b4t_hf` at 2B params, 4T tokens). MediaTek already ships
  BitNet 1-bit support on the Dimensity 9500
  (`mediatek_dimensity_9500_product`).

### R-2:4-TILE: tile-level 2:4 sparse INT4 GEMM

- **Sources:** `sparsegpt_paper`, `wanda_paper`, `maskllm_paper`,
  `trainium2_aws_docs`.
- **Anchor:** `docs/arch/npu.md` `SDOT4_S4_2_4` (scalar only).
- **Recommendation:** lift 2:4 sparsity from a scalar primitive to a
  full INT4 tile op. The sparsity-decode microengine expands 2:4 INT4
  rows into the dense lane input the tile already consumes; no MAC array
  redesign.
- **Why high confidence:** 2:4 N:M is the only sparsity pattern with
  shipping hardware support across every major vendor and a clean
  pruning algorithm. Trainium2's 4x sparse FP8 ratio shows the
  achievable end-state.

### R-IREE-BACKEND: own a single IREE-based compiler backend

- **Sources:** `iree_repo`, `vta_blueprint_paper`,
  `npu-2028-target.software_targets.compiler`.
- **Anchor:** `docs/spec-db/npu-2028-target.yaml` software_targets.
- **Recommendation:** make IREE the upstream compiler entry point and
  emit descriptor sequences from a custom IREE HAL backend.
  ExecuTorch / TFLite delegate adapters target the same backend rather
  than maintaining parallel paths.
- **Why high confidence:** IREE is in the named software_targets list
  already; doubling down avoids fragmenting the compiler effort.

### R-WRITEBACK-DMA: implement DMA writeback before L4 claims

- **Sources:** `nvdla`, `trainium2_aws_docs`, `mtia_v2_isca25`,
  current `docs/arch/npu.md` (descriptor stream reads only).
- **Anchor:** `docs/spec-db/npu-2028-roadmap.yaml` L1 gates
  `dma_trace_bytes_written` and `perf_counter_dma_bytes_written`.
- **Recommendation:** add DMA writeback path to the descriptor engine so
  `DESC_BYTES_WRITTEN` / `DESC_WRITE_BEATS` become non-zero. This is the
  binding gate on L1 phase progression.
- **Why high confidence:** the L1 gates are already specified; the only
  question is implementation timing.

## Medium-confidence recommendations

### R-IOMMU: IOMMU-isolated command buffers for L3

- **Sources:** `vllm_paged_attention`, `pim_mmu_paper`,
  `microarchitecture_targets.memory_system.iommu_isolated_command_buffers`.
- **Anchor:** `docs/spec-db/npu-2028-roadmap.yaml` L3 gate
  `iommu_isolated_command_buffers`.
- **Recommendation:** make every descriptor ring an IOMMU-mapped region
  with per-context page tables. Reuse Linux IOMMU framework rather than
  inventing a custom unit.

### R-PAGED: paged-attention-friendly KV-cache load path

- **Sources:** `vllm_paged_attention`, `streamingllm_paper`, `h2o_paper`,
  `kivi_paper`, `deepseek_v2_mla`, `mla_hardware_paper`.
- **Recommendation:** attention engine KV-load path must accept a
  page-table indirection (page descriptor list) rather than a
  contiguous KV base+stride. Support per-page asymmetric KV-quant scales
  at 2 or 3 bits. Support MLA's low-rank K/V projections via factored
  reads.

### R-MESH-NOC: hierarchical mesh NoC for L3 tile fabric

- **Sources:** `eyeriss_v2_paper`, `tenstorrent_blackhole_microbench`,
  `snitch_cluster_repo`.
- **Recommendation:** plan the L3 tile fabric as a hierarchical mesh
  rather than a flat ring or crossbar. Each tile carries a small RISC-V
  control core (Snitch / baby-core scale).

### R-SPARSE-DECODE: shared sparsity-decode microengine

- **Sources:** `sparsegpt_paper`, `wanda_paper`, `sigma_paper`,
  `eyeriss_v2_paper`.
- **Recommendation:** make the sparsity-decode engine a shared resource
  in front of the dense tiles, not part of each tile. This keeps the
  tile design unchanged for dense work and limits area cost.

### R-ATTN-ENGINE: shared FlashAttention-style attention engine

- **Sources:** `flashattention_paper`, `flashattention2_paper`,
  `flashattention3_paper`, `fusemax_paper`, `spatten_paper`,
  `int_flashattention_paper`.
- **Recommendation:** dedicated attention engine across tiles
  implementing streaming softmax (running max + running sum + running
  output), FP8 / INT8 K/V load with per-block scale, and seq-length-
  independent on-chip buffer. Accept a tree mask alongside the causal
  mask for speculative decoding.

### R-EXECUTORCH-TFLITE: parity adapters, not parallel backends

- **Sources:** `samsung_exynos_2600_page`, IREE design.
- **Recommendation:** ExecuTorch and TFLite delegate paths should be
  thin adapters that produce IREE input; not independent backends.

### R-THERMAL-AWARE: thermal-aware tile scheduler for L5

- **Sources:** `bspdn_thermal_paper`, `subnm_reliability`.
- **Recommendation:** L5 scheduler must consider per-tile temperature
  and reliability budgets, not just queue depth. BSPDN-enabled designs
  exhibit non-uniform hotspots; sub-3 nm AI accelerators age faster
  than RISC-V cores in the same process.

## Lower-confidence recommendations (need more design work)

### R-CIM-SLOT: optional digital SRAM CIM slot

- **Sources:** `tsmc_dcim_isscc2024`, `cim_tpu_paper`, `syndcim_paper`,
  `cim_landscape_survey`.
- **Recommendation:** design the L4 / L5 tile so a weight SRAM bank can
  be transparently replaced with a digital CIM macro without changing
  the tile ABI. Decide actual CIM inclusion at silicon planning time
  based on 14A-node IP availability.

### R-MLA-LOW-RANK: hardware support for MLA-style factored attention

- **Sources:** `deepseek_v2_mla`, `mla_hardware_paper`.
- **Recommendation:** consider factored-K / factored-V load paths for
  MLA. The implementation cost is modest if planned in with the
  attention engine; the bandwidth saving is large. Confidence is
  medium-low because the MLA standard is still evolving and 2028
  production LLMs may converge on something else.

### R-SSM-PATH: a state-space chunk kernel

- **Sources:** `mamba2_paper`, `lightmamba_paper`.
- **Recommendation:** monitor whether SSM models become competitive on-
  device. If so, plan a state-space chunk kernel that runs through the
  existing GEMM tile rather than building dedicated hardware.

### R-ANALOG-CIM-MICRO: analog CIM for the always-on micro-NPU only

- **Sources:** `encharge_ieee_spectrum`, `encharge_en100_dcd`.
- **Recommendation:** keep analog CIM as a contained option for the
  20 mW always-on tier (per `npu-2028-target.workload_targets.always_on_micro_npu_power_mw_max`).
  Do not commit it to the main NPU.

## Recommendations NOT made

- Unstructured sparsity acceleration in hardware. The accuracy gain over
  2:4 is too small relative to the area cost.
- A fully reconfigurable interconnect (MAERI-class). Verification and
  area cost are not justified at the E1 workload profile.
- A Groq-style fully static dataflow. Workload diversity defeats the
  win.
- LPDDR-side PIM as a dependency. Track JEDEC and vendor partnerships,
  but do not bake it into the spec.
- ReRAM / PCM / MRAM CIM. Watch only; no foundry-grade 14A IP yet.

## Verification path

Each recommendation must, before any RTL or spec change lands, satisfy:

1. Updated `docs/spec-db/e1-npu-runtime-contract.json` and
   `docs/spec-db/npu-2028-roadmap.yaml` gates.
2. Updated cocotb / Verilator smoke
   (`verify/verilator/test_npu_*`, `compiler/runtime/test_e1_npu_*`).
3. Updated runtime checker
   (`scripts/check_e1_npu_runtime_contract.py`).
4. Updated target-readiness checker
   (`scripts/check_npu_2028_targets.py`).
5. Linked source IDs in this packet's `01_sources/source_inventory.yaml`
   in the corresponding spec or RTL commit.

No accelerator claim crosses a phase gate without measured evidence; the
recommendations above are design guidance for the spec, not substitutes
for the gates.
