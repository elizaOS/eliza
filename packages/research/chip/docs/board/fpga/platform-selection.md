# FPGA prototyping platform selection

Status: decision recorded
Owner: board/fpga
Date: 2026-05-17

## Decision

The project commits to a two-stage FPGA prototyping strategy:

1. **Stage 1 (now, e1-demo MMIO):** Lattice ECP5 on a **Radiona/FER ULX3S 85F** board.
   Bring-up runs entirely on the open-source toolchain (Yosys / nextpnr-ecp5 /
   ecppack / openFPGALoader). No vendor license, no NDA, no closed binary in
   the bitstream path.
2. **Stage 2 (M5+, Rocket + Gemmini):** Xilinx **VCU118 (XCVU9P)** for the
   on-prem owned-hardware path, or **FireSim on AWS F1/F2** for the
   cloud-burst path. Both paths target the same Chipyard generator output, so
   the SoC RTL is identical.

The two stages are sequential, not exclusive. The ECP5 platform stays in the
lab for e1-demo and small regression bring-up even after the VCU118 / F1
flow comes online for the Rocket+Gemmini SoC.

## Why two stages

The e1-demo MMIO chip and the Rocket+Gemmini SoC have resource budgets
that differ by roughly two orders of magnitude. Forcing both onto a single
platform either over-pays for e1-demo (waiting on a VCU118 just to blink
an LED) or under-provisions for Rocket+Gemmini (Rocket alone barely fits an
ECP5-85F; Gemmini does not fit at all). Splitting the platform decision lets
e1-demo bring-up run today on cheap, fully open silicon while the heavier
SoC stays on a path with realistic capacity headroom.

## Resource budget comparison

Estimates below are order-of-magnitude. They are sourced from public
Chipyard FPGA reports (Rocket small-config) and Gemmini paper datapoints
(16x16 systolic array, INT8) plus typical DDR controller overhead.

| Design                | LUT (k) | FF (k) | BRAM (Mb) | DSP   | Off-chip DRAM | Fits ECP5-85F | Fits Zynq-7020 | Fits VCU118 (XCVU9P) |
|-----------------------|--------:|-------:|----------:|------:|---------------|:-------------:|:--------------:|:--------------------:|
| e1-demo MMIO       |   < 10  |   < 8  |    < 0.5  |    0  | none (BRAM)   | yes           | yes            | overkill             |
| Rocket small (1 core) |    35   |   20   |     4     |   10  | 256 MB DDR    | tight, no DDR | tight, no DSP  | yes                  |
| Rocket + Gemmini 16x16|  ~150   |  ~100  |    ~20    |  ~200 | >= 1 GB DDR4  | **no**        | **no**         | yes                  |

ECP5-85F has ~84 k LUT4 and ~3.7 Mb BRAM and no hard DDR4 PHY. It is
fundamentally below the Rocket+Gemmini line on both logic and memory
bandwidth. Zynq-7020 has ~53 k LUT and 4.9 Mb BRAM with only DDR3 via the PS
side; it cannot host Gemmini's DSP-heavy MAC array. HAPS-class emulators
(HAPS-100/200) fit easily but cost six figures per seat and are not
justified before tape-out planning starts.

VCU118 (XCVU9P) has ~1.18 M LUT, ~75 Mb URAM+BRAM, 6840 DSP slices, and an
on-board DDR4 SODIMM slot wired to a hard PHY. Rocket+Gemmini lands at
roughly 10-15 % LUT utilization with room for L2, DMA, and a debug bridge.

## Recommendation

- If the program owns or can buy hardware: **VCU118**. One-time capex,
  deterministic wall-clock, no per-hour burn, JTAG and UART local. Vivado is
  required and is the only closed-source dependency in this path.
- If the program prefers cloud-burst and accepts AWS lock-in: **FireSim on
  F1 (or F2 when generally available)**. Chipyard's FireSim flow generates
  the target automatically; metasim runs locally for correctness and the
  same target lifts to F1 for performance. Pay-per-hour, no hardware to
  maintain, but bitstream build still runs Vivado inside the FireSim manager.

The two stage-2 options are not mutually exclusive. The recommended order is
metasim -> VCU118 (if hardware is available) -> F1 for long-running
benchmark sweeps.

## What this decision does not cover

- Tape-out emulation (HAPS, Palladium, ZeBu): out of scope until after PD
  signoff begins.
- ASIC-class power and timing correlation: FPGA prototyping is for
  functional bring-up and software co-development only.
- Analog and RF blocks: not FPGA-targetable; covered by board-level
  external modules per `board/fpga/package/wifi_external_module_adapter.yaml`.

## Stage 1 board facts

- Demo board class: ULX3S 85F.
- FPGA part family used by the scaffold: `LFE5U-85F-6BG381C`.
- nextpnr target: `--85k --package CABGA381`.
- Clock assumption: 25 MHz onboard `clk_25mhz`.
- Programming assumption: SRAM programming with `openFPGALoader -b ulx3s`.
- Release blocker: the exact purchased/assembled board revision is still
  `unassigned`, so the LPF remains a scaffold even though it has concrete
  preliminary package sites.

## References

- `docs/board/fpga/README.md`
- `docs/rtl/open_rtl_prototype_path.md`
- `docs/project/board-package-pd-fpga-critical-gap-audit.md`
- `docs/generators/chipyard/README.md`
- `docs/toolchain/headless-cli-audit.md`
- Future VCU118 and FireSim bring-up docs once those stage-2 paths exist.
