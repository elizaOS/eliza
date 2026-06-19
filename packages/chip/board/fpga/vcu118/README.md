# VCU118 scale-up bring-up plan (Rocket + Gemmini)

Status: planning, M5+
Owner: board/fpga
Platform decision: see `docs/board/fpga/platform-selection.md`

## Purpose

This is the on-prem, owned-hardware path for prototyping the Chipyard-generated
Rocket + Gemmini SoC. The e1-demo MMIO chip continues to live on the
ULX3S/ECP5 path; the VCU118 is reserved for the heavier configuration that
does not fit on ECP5.

## Hardware

- Board: **Xilinx VCU118** evaluation kit
- FPGA: **XCVU9P-L2FLGA2104E** (UltraScale+, speed grade -2)
- DDR4: on-board 80-bit SODIMM slot (typ. 4 GB single-rank @ 2400 MT/s)
- Host link: JTAG (Digilent FTDI on-board) and USB-UART (Silicon Labs CP2105)
- Power: 12 V brick included; lab bench supply acceptable
- Programmer: Vivado hw_server over JTAG; no external programmer needed

## Toolchain

| Tool        | Version (baseline) | Notes                              |
|-------------|--------------------|------------------------------------|
| Vivado      | 2023.2 or 2024.1   | Required. Closed-source; license needed. |
| Chipyard    | tracked release    | Same generator tree as RTL sim.    |
| RISC-V GNU  | 13.x               | For boot ROM and Linux build.      |
| OpenOCD     | 0.12+              | For RISC-V debug via JTAG passthrough. |

Vivado is the only closed dependency in this path. The Chipyard FPGA shell
for VCU118 lives in `fpga/fpga-shells/src/main/scala/xilinx/vcu118/` upstream
and is consumed unchanged.

## Expected utilization budget (Rocket small + Gemmini 16x16, INT8)

Numbers are estimates; the first real synthesis run replaces them.

| Resource        | Used (est) | Available | Utilization |
|-----------------|-----------:|----------:|------------:|
| CLB LUTs        | ~150 k     | 1,182 k   | ~13 %       |
| CLB FFs         | ~100 k     | 2,364 k   | ~4 %        |
| BRAM (36 Kb)    | ~250       | 2,160     | ~12 %       |
| URAM (288 Kb)   | ~20        | 960       | ~2 %        |
| DSP48E2         | ~256       | 6,840     | ~4 %        |
| DDR4 controller | 1          | 1 hard IP | required    |

Headroom is comfortable. A 16x16 INT8 Gemmini is the planned baseline; a
32x32 variant remains within budget and is the M6 stretch.

## Bitstream flow (Vivado)

1. Generate the target from Chipyard:
   ```
   cd $CHIPYARD/fpga
   make -C fpga SUB_PROJECT=vcu118 CONFIG=RocketGemminiVCU118Config bitstream
   ```
2. Output: `fpga/generated-src/.../obj/system.bit` plus `system.mcs` for QSPI.
3. Reports to capture (commit to `build/fpga/vcu118/reports/`):
   - `*_utilization_placed.rpt`
   - `*_timing_summary_routed.rpt`
   - `*_power_routed.rpt`

## DDR4 bring-up

- The Chipyard VCU118 shell instantiates the Xilinx DDR4 MIG with the
  on-board SODIMM pinout. No custom PHY work required.
- Calibration runs at FPGA power-on; the cal-done signal is wired to a
  status LED in the shell. Bring-up gate: cal-done within 5 s of power.
- Memory test: `mem_check` boot-stub walks 32 MB, 256 MB, and 1 GB ranges.
- Bandwidth target for Gemmini DMA: >= 6 GB/s sustained on linear reads
  (well below the ~19 GB/s DDR4-2400 raw ceiling).

## JTAG / UART bring-up checklist

- [ ] Vivado hw_server detects the device chain (one XCVU9P).
- [ ] Bitstream loads; DONE goes high; cal-done LED asserts.
- [ ] CP2105 enumerates two TTY endpoints; one is the boot console.
- [ ] OpenOCD connects to the RISC-V debug module over JTAG passthrough.
- [ ] `riscv64-unknown-elf-gdb` halts the hart and reads `mhartid == 0`.
- [ ] Boot ROM prints banner on UART at 115200 8N1.
- [ ] Linux kernel reaches userland; serial console responsive.

## Out of scope for this document

- HBM-based boards (VCU128, U280): not the planned platform.
- Multi-FPGA partitioning: not required at Rocket+Gemmini size.
- Analog and RF: external module path only (see WiFi adapter yaml).

## References

- `docs/board/fpga/platform-selection.md`
- `docs/board/fpga/firesim-bringup.md`
- `docs/generators/chipyard/README.md`
- Xilinx UG1224 (VCU118 board user guide)
