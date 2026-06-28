# E1 demo package contract

Evidence class: `non_release_demo_planning`
Release use: `prohibited`
Planning revision: `2026-05-17-r0`

The demo board target uses `e1_demo_qfn64_planning_r0`, a local QFN64-style
planning contract for KiCad symbol work, FPGA harness mapping, and first-article
procedure drafting. It defines a specific demo package envelope, pin numbering
rule, rail budget scaffold, and board-net map.

This is local planning data only. It is not vendor package data, a bond diagram,
a land-pattern source, or release evidence. Fabrication and tapeout claims must
remain blocked until the package vendor/foundry evidence listed below is
archived with immutable revisions or SHA-256 checksums.

## Local planning package

- Package ID: `e1_demo_qfn64_planning_r0`.
- Package family: QFN-style local planning envelope, 64 perimeter pins.
- Body envelope: `9.0 mm x 9.0 mm`, `0.50 mm` nominal pitch, top-view
  counterclockwise numbering, 16 pins per side.
- Pin 1 convention: upper-left reference corner in top view.
- Exposed pad: unassigned for planning; do not generate paste, mask, or thermal
  via release data from this field.
- IO rail: `3.3 V` planning rail on `VDDIO[0:4]` with matching `VSSIO[0:4]`
  returns.
- Core rail: `1.8 V` planning rail on `VDDCORE[0:3]` with matching
  `VSSCORE[0:3]` returns.
- Clock: `CLK_IN` on board net `OSC_CLK`, nominal `25 MHz`, maximum planning
  constraint `50 MHz`.
- Reset: `RST_N` active low on board net `RESET_N`.
- Debug/MMIO: 4-bit address, write-data, and read-data buses with valid, launch,
  write, and ready handshake pins.
- Smoke outputs: `GPIO[7:0]` to LED planning nets and IRQ outputs to test-point
  planning nets.
- Reserved debug: `TEST_MODE` plus JTAG pins for debug or scan planning only.

The machine-readable source of truth is
`package/e1-demo-pinout.yaml`.

## Board and FPGA planning use

KiCad work may use this contract to create a non-fabrication schematic symbol,
net classes, connector planning, and cross-probe checks. It must not create a
fabrication-ready footprint, paste layer, courtyard, assembly drawing, Gerbers,
or purchase package from this file.

FPGA work may use the same signal names for the `e1_demo_fpga` target:
`CLK_IN`, `RST_N`, debug/MMIO, GPIO, IRQ, `TEST_MODE`, and JTAG. Bitstream
release remains blocked until a concrete FPGA board revision, final LPF, timing
report, packed bitstream, and tool-version archive are checked in by the board
flow.

## First-article planning limits

These limits are procedure scaffolds, not validated electrical ratings:

- `VDDIO` `3.3 V`: initial current limit `25 mA`, hard stop `150 mA`.
- `VDDCORE` `1.8 V`: initial current limit `50 mA`, hard stop `250 mA`.
- Ramp order: current-limit both supplies, enable `VDDIO`, enable `VDDCORE`,
  confirm clock, assert reset low, release reset, then exercise debug/MMIO.
- Stop conditions: rail overvoltage, current-limit hit after reset release,
  rail collapse, package or board hot spot, oscillator absent, reset stuck, or
  debug bus contention.

Before board fabrication release these limits must be replaced or approved
against post-route power, package/board PI, regulator, fuse, and thermal
evidence.

## Release blockers

- Package-vendor drawing with revision, dimensions, tolerances, exposed-pad
  data if applicable, material constraints, and pin-1 orientation is missing.
- Package-vendor land-pattern or footprint source with checksum is missing.
- Shuttle/package approval evidence is missing.
- Bond diagram mapping die pads to package pins is missing.
- Foundry IO, ESD, power, ground, and corner pad cells are not selected.
- Package electrical/parasitic model is missing.
- Package-to-padframe-to-RTL-to-board cross-probe report is missing.
- KiCad schematic, PCB, ERC, DRC, Gerbers, drill, BOM, position, DFM, SI/PI, and
  first-article evidence are missing.

Do not use this document as fabrication, tapeout, package, or board release
evidence.
