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
