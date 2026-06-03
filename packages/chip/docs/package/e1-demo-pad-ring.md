# E1 demo pad-ring contract

Evidence class: `non_release_demo_planning`
Release use: `prohibited`
Planning revision: `2026-05-17-r0`

The current RTL exposes a chip-level digital interface but does not instantiate
foundry IO cells. This document records the concrete pad-ring planning contract
for `e1_demo_qfn64_planning_r0` so package, KiCad, FPGA, and physical-design
work can use the same signal names before a foundry pad library is selected.

This is not foundry padframe release evidence. Tapeout and board release must
remain blocked until selected IO cells, ESD strategy, pad placement, package
bonding, and padframe-inclusive signoff reports are archived.

## Planned pad classes

- IO supply pads: `VDDIO0`, `VDDIO1`, `VDDIO2`, `VDDIO3`, `VDDIO4`.
- IO return pads: `VSSIO0`, `VSSIO1`, `VSSIO2`, `VSSIO3`, `VSSIO4`.
- Core supply pads: `VDDCORE0`, `VDDCORE1`, `VDDCORE2`, `VDDCORE3`.
- Core return pads: `VSSCORE0`, `VSSCORE1`, `VSSCORE2`, `VSSCORE3`.
- Clock pad: `CLK_IN`, low-skew digital input on board net `OSC_CLK`.
- Reset pad: `RST_N`, Schmitt-style active-low input with pull-up intent.
- Digital inputs: debug/MMIO write-side pins, `DBG_LAUNCH`, `TEST_MODE`, and
  JTAG inputs.
- Digital outputs: debug/MMIO read-side pins, `DBG_READY`, IRQ outputs,
  `GPIO[7:0]`, and `JTAG_TDO`.
- No-connect pins: pins 40, 41, 42, 51, 52, 53, 54, 59, 60, 61, and 62 until a
  vendor bond diagram assigns a different disposition.

The package pinout remains the machine-readable contract:
`package/e1-demo-pinout.yaml`.

## Planning placement intent

- Keep power and ground pins distributed across all four package sides for
  early KiCad and PDN planning.
- Keep `CLK_IN` and `RST_N` adjacent to the debug bus side so FPGA and board
  smoke harness routing stays short.
- Route IRQ outputs and GPIO outputs to LED or logic-analyzer nets for
  first-article observability.
- Reserve JTAG and `TEST_MODE` for a normally unpopulated debug header until a
  product debug policy is approved.
- Treat the OpenLane block as a core/hard-macro candidate until real pads,
  clamps, corners, and pad-ring keepouts are selected.

## Release blockers

- Foundry IO, power, ground, corner, clamp, and ESD cells are not selected.
- Pad-ring floorplan, keepouts, pad pitch, pad placement, and bond-pad geometry
  are absent.
- IO timing, drive strength, clamp, leakage, and voltage-tolerance models are
  missing.
- Padframe-inclusive DRC, LVS, antenna, ESD, and latch-up evidence is missing.
- Power-domain and ESD strategy is not proven against package pins and board
  rails.
- Bond diagram and package-to-padframe mapping are missing.
- Package electrical model and SI/PI reviews are missing.

Do not use this file as fabrication, tapeout, package, or board release
evidence.
