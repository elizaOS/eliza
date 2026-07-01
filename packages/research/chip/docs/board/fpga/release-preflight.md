# FPGA release preflight

`e1_demo_fpga` is blocked from bitstream release until the repository contains reproducible board, pin, timing, bitstream, and toolchain evidence. The scaffold contract is checked by `make fpga-check`; release evidence is checked by `make fpga-release-check`.

The release check is intentionally stricter than the scaffold check. It requires:

- `board/fpga/e1_demo_fpga.yaml` to be `status: release_ready`.
- `board.exact_revision`, `board.exact_revision_evidence`, `board.ecp5_device`, and `board.ecp5_package` to name a real board and FPGA part/package.
- `constraints.final_lpf` to point to a final LPF, not the scaffold LPF.
- One non-comment `LOCATE COMP` assignment for every required physical `e1_chip_top` signal.
- A clock frequency constraint for `CLK_IN` matching the manifest frequency.
- Local `nextpnr-ecp5` and `ecppack` tools to be available when claiming timing or bitstream evidence.
- Archived timing report, bitstream file, SHA-256 digest, and tool versions.

The current scaffold uses public ULX3S 85F pin names only where they are visible in the upstream `ulx3s_v20.lpf`: `CLK_IN` uses the 25 MHz `clk_25mhz` site, `GPIO[7:0]` uses the eight blink LEDs, `RST_N` uses the active-low power button, and remaining low-speed debug/user pins use GP/GN header sites. Do not promote those preliminary assignments to release status until the exact board revision schematic or vendor pin table is archived in the release manifest.
