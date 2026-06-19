# Eliza-AI-SoC v0.1 architecture contract

The first executable artifact is `e1_soc`, a tiny pre-tapeout chip used to validate the repository, toolchain, and verification flow.

## E1 chip blocks

```text
boot ROM
MMIO peripheral block
timer interrupt
GPIO output
DMA memory-copy engine
NPU scalar/SIMD/GEMM datapath
display scanout controller
CPU subsystem AXI-Lite boundary stub
debug-visible SRAM-backed DRAM aperture
AXI-Lite DRAM boundary model for the Linux-capable scaffold
AXI-Lite interconnect scaffold
PLIC-style interrupt controller scaffold
```

## Full SoC target

The long-term target remains an AOSP-capable open RISC-V AI phone application processor:

```text
RV64GC application CPU subsystem
management/security RISC-V core
cache hierarchy
TileLink/AXI interconnect
external memory controller/PHY boundary
on-chip SRAM
NPU
DMA
display and 2D graphics
storage, USB digital boundary, audio, sensors, GPIO, debug
OpenSBI, U-Boot, Linux, AOSP device support
```

The current selected Chipyard/Rocket path is a Linux bring-up stepping stone for
that target. It must not be treated as a 2028 phone-class AP until the CPU/AP
evidence manifest closes topology, ISA, cache/coherency, MMU, boot, benchmark,
power/thermal, Android, and silicon gates.

The e1 chip keeps the same contract style while making the first end-to-end flow fast enough to run constantly.

## Contract scaffold

The Linux-capable CPU/interconnect/interrupt scaffold is not wired into the e1-chip pad-level design yet. It lives under `rtl/cpu`, `rtl/interconnect`, `rtl/memory`, and `rtl/interrupts`, with `e1_linux_soc_contract` serving as the integration wrapper for verification. This keeps the first chip stable while establishing the future CPU, external DRAM controller, interconnect, and interrupt-controller boundary.

## Integrated SoC top (2028 target)

`rtl/top/e1_soc_integrated.sv` is the integration top that wires up the eight 2028-target domains: BPU (`bpu_top`), CSR/Zihpm (`zihpm` + `bpu_to_zihpm_remap`), OoO cluster (`e1_cluster_top` in lite tie-off mode), cache south boundary (`tl_c_to_chi_bridge` + `e1_chi_to_axi4_bridge`), AXI4 fabric (`e1_axi4_interconnect`), IOMMU (`e1_riscv_iommu`), DRAM (`e1_dram_ctrl` + `e1_axi4_dram_model`), power (`pmc_top`), plus the existing peripherals (boot ROM, GPIO, timer, DMA, NPU, display, weight-buffer SRAM). The v0 `e1_chip_top` + `e1_soc_top` path is kept untouched and runnable.

Cross-domain wiring contract: `docs/arch/soc-integration.md`. Boot-smoke and cross-domain cocotb gates: `docs/evidence/integration/`. Make targets: `make cocotb-soc-boot-smoke`, `make cocotb-cross-domain`, `make soc-integration-check`.
