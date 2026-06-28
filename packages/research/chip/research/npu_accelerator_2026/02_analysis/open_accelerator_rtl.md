# Open-source NPU / GPU / tensor RTL, keyed to E1 integration paths

Date: 2026-05-19

This file enumerates the open-source accelerator RTL options that are
realistically integrable into E1 against the phase gates in
`docs/spec-db/npu-2028-roadmap.yaml`. It does not claim that any of the
listed options is the right choice for L5; it identifies which option fits
which phase.

## E1 current state, summarized

- `rtl/npu/e1_npu.sv` is a single-MMIO scalar/packed datapath with a 64-byte
  scratchpad and bounded GEMM (`M<=3, N<=3, K<=7`). See `docs/arch/npu.md`.
- `docs/arch/npu-microarch.md` plans to wrap **Gemmini** behind an
  MMIO-fronted command-queue (`e1_npu_gemmini_wrapper.sv`) and keep the
  legacy datapath as a fallback target.

The open RTL choices below are evaluated against that plan.

## Open-source candidates

### Gemmini (`gemmini_paper`, `gemmini_repo`, `gemmini_chipyard_docs`)

- **Role for E1:** confirmed wrapped-tile candidate for v0 / L2.
- **Why:** RoCC + Rocket / BOOM integration, fabricated test SoCs in
  TSMC 16 nm and Intel 22FFL, documented dataflows (weight-stationary and
  output-stationary), an existing Chipyard build flow already in
  `packages/chip/scripts/bootstrap_chipyard.sh`.
- **Limitations:** at the default 16x16 INT8 array, peak per-tile
  throughput is 256 INT8 MACs/cycle (well above E1's L2 gate of 256
  MAC units / 128 MACs/cycle, but well below the L3 / L5 targets that
  require 4096 INT8 MAC units per tile and 8..16 tiles). Gemmini scales by
  instantiating multiple cores; it does not natively support 2:4 sparse
  INT4 or BitNet.
- **Recommendation:** keep Gemmini for L0 / L1 / L2 evidence; do not bet
  L5 numbers on it without a sparse-aware tile add-on.

### NVDLA (`nvdla`)

- **Role for E1:** secondary reference for descriptor + IRQ + bus-fault
  semantics, not the primary tile.
- **Why:** NVDLA ships Verilog, a C-model, an open compiler, and a Linux
  driver — all the artifacts L4_ANDROID_HAL_DELEGATE requires in some
  form. The NVDLA register model is also the closest open analog to
  `docs/arch/npu-microarch.md`'s descriptor ring + status / error code
  scheme.
- **Limitations:** the NVDLA tile is INT8-only, has no FP8 / INT4 / INT2
  path, and is no longer actively developed.

### VTA + TVM (`vta_tvm`, `vta_blueprint_paper`)

- **Role for E1:** reference for the compiler/runtime seam, not the tile.
- **Why:** two-level ISA, JIT compilation, integrated with TVM. Useful for
  thinking about how to expose the bounded-GEMM ABI to a tensor compiler
  without overcommitting the hardware to a fixed operator set.
- **Limitations:** the VTA design point is small (28 nm FPGA-class); not
  used as the production tile.

### IREE + MLIR (`iree_repo`)

- **Role for E1:** primary compiler/runtime stack candidate, listed
  explicitly under `npu-2028-target.software_targets.compiler`
  (IREE_or_TVM_backend).
- **Why:** retargetable MLIR-based, supports StableHLO and PyTorch via
  Torch-MLIR / ExecuTorch import, and Linux Foundation AI & Data sandbox
  status as of May 2024. Maps cleanly onto the StableHLO / TFLite import
  expectations.
- **Recommendation:** use IREE as the upstream-import side and add a
  custom HAL backend that emits E1 descriptors. Do not invent a parallel
  compiler.

### Vortex GPGPU (`vortex_gpgpu`)

- **Role for E1:** considered and rejected.
- **Why rejected:** a GPGPU is a poor fit for the 18 TOPS/W INT8 target.
  Vortex would push us toward an OpenCL-style data-parallel programming
  model and away from a tensor-instruction model. Captured here so the
  decision is recorded.

### Snitch cluster (`snitch_cluster_repo`) and PULP

- **Role for E1:** reference for the tile-cluster scaffold around a
  GEMM accelerator.
- **Why:** Snitch couples small RISC-V cores with a shared scratchpad and
  a tensor instruction extension (FREP, SSR). When E1 needs multiple
  Gemmini tiles cooperating around a shared SRAM region, the Snitch
  cluster organization is the most well-documented reference.

### RedMulE (`redmule_paper`, `redmule_engine_paper`)

- **Role for E1:** reference for FP8 / FP16 mixed-precision GEMM perf/W in
  a phone-relevant process.
- **Why:** 1.19 TFLOPS/W (FP16) and 1.67 TFLOPS/W (FP8) at 22 nm, 0.65 V.
  This is a sanity baseline. E1's 18 INT8 TOPS/W sustained target on a
  14A-class process is more than 10x this point, which is achievable but
  not free — RedMulE provides the trajectory.

### OpenGeMM (`opengemm`)

- **Role for E1:** comparison point for Gemmini utilization.
- **Why:** 4.68 TOPS/W reported. Useful when arguing in
  `03_implementation/` whether to push Gemmini's tile size or to switch to
  a generator with higher reported utilization.

### ESP (`esp_columbia`) and OpenCelerity (`opencelerity`)

- **Role for E1:** references for heterogeneous SoC integration and
  context-isolation patterns at L3.
- **Why:** both provide open SoC platforms with accelerator integration
  flows that include IOMMU, command-buffer, and HLS pipelines. These are
  not tile candidates, they are integration patterns.

### TPU-Gen (`tpu_gen_paper`)

- **Role for E1:** long-horizon generator option.
- **Why:** LLM-driven generation of systolic tiles. Of note if E1 evolves
  toward a generator-driven multi-tile complex; not adopted today.

## Integration matrix vs phase gates

| Phase | Tile RTL | Driver / runtime | Compiler | Verification |
| --- | --- | --- | --- | --- |
| L0 (current) | `rtl/npu/e1_npu.sv` (custom scalar + bounded GEMM) | `compiler/runtime/e1_npu_runtime.py` | Smoke lowerings in `compiler/runtime/e1_npu_lowering.py` | `verify/verilator/test_npu_gemm.cpp`, `compiler/runtime/test_e1_npu_runtime_sim.py` |
| L1 | Same tile + descriptor ring + DMA path | Descriptor-submitting kernel driver | Smoke lowerings producing descriptors | DMA byte-counter evidence; descriptor timeout/error checks |
| L2 | **Gemmini** wrapped at default 16x16 INT8 | NVDLA-style descriptor + IRQ semantics inside `e1_npu_gemmini_wrapper.sv` | IREE backend emitting Gemmini-shaped ops | Tile cycle-accurate model + RTL co-simulation |
| L3 | Multi-Gemmini-tile cluster (Snitch / PULP scaffolding) | Per-context command buffers via IOMMU | IREE backend with multi-tile schedule | QoS + fault-isolation traces |
| L4 | Same as L3 + sparsity-decode and FP8 / MXFP / INT2 add-ons | AIDL HAL + SELinux + ExecuTorch/TFLite delegate | IREE + ExecuTorch backend | VTS, CTS, NNAPI accelerator query |
| L5 | L4 hardware + optional digital SRAM CIM tile | Mature delegate; thermal-aware scheduler | Full operator coverage | MLPerf Mobile, power/thermal traces |

This matrix is a planning artifact. It does not commit any specific RTL or
software choice; it shows which open building blocks remain consistent
across phases.

## What does NOT exist openly

- A peer-reviewed open RTL that fully implements an 8..16-tile mobile NPU
  with 64+ MiB local SRAM, 2:4 sparsity decode, FP8 + INT2 + INT4
  precision, IOMMU-isolated command buffers, and a production Android
  delegate. Every open candidate covers a subset.
- An open RTL that integrates digital SRAM CIM at production-grade. We
  have foundry CIM macros (`tsmc_dcim_isscc2024`) and DCIM compilers
  (`syndcim_paper`), but no full-stack open implementation.
- An open RTL with a verified attention engine matching FuseMax-class
  utilization. SpAtten RTL (`spatten_repo`) is the closest, but it is
  research-grade and BERT/GPT-2-oriented.

These gaps mean the L4 / L5 tile is partially custom work, not just
integration of open IP.
