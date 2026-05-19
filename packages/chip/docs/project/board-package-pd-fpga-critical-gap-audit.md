# Board/package/PD/FPGA critical gap audit

Date: 2026-05-17
Scope: `board/**`, `package/**`, `pd/**`, `scripts/check_fpga_target.py`, `scripts/check_padframe_contract.py`, `scripts/check_pd_signoff.py`, and `scripts/product_check.py`.

## Release posture

The current tree is a contract scaffold, not a release-ready board, package, tapeout, or FPGA bitstream package. `product-check` must be interpreted as a release gate after this audit: it fails while placeholder packages, missing KiCad artifacts, incomplete PD signoff, and FPGA pin-assignment blockers remain.

## Placeholder package and padframe artifacts

- `package/e1-demo-pinout.yaml` declares `package: qfn64_placeholder` and notes that real foundry pad cells, ESD rules, package data, and bond diagrams must replace it before fabrication.
- `docs/package/e1-demo-package.md` is explicitly a placeholder QFN64-style planning document and states that it is not a foundry-approved package.
- `docs/package/e1-demo-pad-ring.md` states that RTL does not instantiate foundry pad cells; ESD and corner pads are delegated to a future shuttle/package flow.
- `pd/padframe/e1_demo_padframe.yaml` has `status: contract_scaffold`, with release gates blocked for padframe, package, and board fabrication.
- `docs/pd/padframe/e1_demo_padframe.md` is a planning contract, not foundry IO-ring release evidence.

Required closure:

- Replace placeholder QFN64 planning data with package-vendor drawing, dimensions, tolerances, pin-1 orientation, exposed-pad data, and assembly constraints.
- Add a released bond diagram mapping die pads to package pins.
- Instantiate foundry IO, power, ground, corner, and ESD pads.
- Archive padframe-inclusive DRC and LVS evidence.
- Cross-probe RTL ports, pad cells, die pads, package pins, KiCad symbol pins, footprint pads, and board nets.

## Pin assignment gaps

- The package pinout assigns logical chip pins to placeholder package pin numbers and board nets, but those assignments are not backed by package-vendor or foundry bonding data.
- Pins `NC1` through `NC11` are intentionally no-connect package positions and have no functional assignment.
- The FPGA constraint skeleton `board/fpga/constraints/e1_demo_ulx3s.lpf` lists required logical ports only in comments. There are no active `LOCATE COMP` package-pin assignments.
- `board/fpga/e1_demo_fpga.yaml` records `board.exact_revision: unassigned` and keeps `bitstream_release_blocked_until_pins_assigned: true`.
- WiFi adapter names are documented as a future external-module surface in the FPGA LPF comments but are not assigned in the current e1-demo package pinout or FPGA target.

Required closure:

- Select an exact FPGA board revision and assign every `e1_chip_top` external signal to physical FPGA package pins.
- Replace LPF comments with concrete `LOCATE COMP`, `IOBUF`, and clock constraints.
- Verify reset polarity, oscillator frequency, IO bank voltages, and debug host wiring on hardware.
- Decide whether each no-connect package pin remains NC in the released package or is repurposed with package and board evidence.

## Missing KiCad and board fabrication artifacts

Only `docs/board/kicad/e1-demo/fab-notes.md` exists under the KiCad project directory. The following release artifacts are missing:

- `*.kicad_pro`
- `*.kicad_sch`
- `*.kicad_pcb`
- KiCad symbol library and footprint library generated from vendor package data
- ERC transcript
- DRC transcript
- plot/Gerber export
- drill export
- BOM export
- position/CPL export
- assembly drawing
- fabrication drawing
- board stackup and impedance target evidence
- assembly-house DFM review

Required closure:

- Create the KiCad project from released package data, not from the placeholder pinout alone.
- Archive headless ERC/DRC and manufacturing exports.
- Add footprint-source checksum or immutable vendor drawing revision.
- Record first-article current limits and stop conditions for both rails.

## Missing SI/PI, PDN, and current-budget evidence

`pd/signoff/manifest.yaml` explicitly marks `si_pi` and `pdn_current_budget` as blocked. Missing evidence includes:

- Package IBIS, SPICE, S-parameter, or extracted parasitic model.
- Board stackup and return-path review.
- Clock, reset, debug, GPIO, IRQ, and JTAG signal-integrity report.
- Rail impedance and decoupling review for `VDDCORE` and `VDDIO`.
- Post-route power report.
- Static, dynamic, peak, and margin current budget for `VDDCORE`.
- Static, dynamic, peak, and margin current budget for `VDDIO`.
- IR-drop and EM reports.
- Board regulator, fuse/current-limit, and thermal review.
- Bench bring-up current-limit evidence.

Required closure:

- Generate post-route power and PDN reports from the selected routed run and selected workloads.
- Tie board current limits to either post-route power or measured first-silicon data with explicit margin.
- Archive SI/PI review artifacts under the globs already declared in `pd/signoff/manifest.yaml`.

## Missing DRC/LVS/STA/OpenLane signoff

No complete OpenLane/OpenROAD run directory was found under the manifest run roots:

- `pd/openlane/runs`
- `runs`

The required signoff artifact classes are declared in `pd/signoff/manifest.yaml` but absent from one complete selected run:

- final GDS
- final DEF
- gate-level netlist
- corner manifest
- final SDC
- SPEF
- SDF
- DRC report
- LVS report
- antenna report
- STA report
- utilization report
- congestion report
- density/fill report
- tool-version record
- waiver file for any non-clean report

Release gates still blocked in the manifest:

- `pd_release`
- `tapeout_release`
- `board_fabrication_release`

Required closure:

- Run the selected OpenLane/OpenROAD flow to completion.
- Archive one self-consistent run containing all required artifacts.
- Fail the release if any required report has violations and no waiver exists.
- Record selected PDK, standard-cell library, RC corner, voltage, temperature, timing modes, and tool versions.

## FPGA bitstream blockers

`scripts/check_fpga_target.py` validates the current scaffold contract, but it is not a bitstream release check. The release blockers are:

- `board/fpga/e1_demo_fpga.yaml` has `status: scaffold`.
- `board.exact_revision` is `unassigned`.
- `constraints.bitstream_release_blocked_until_pins_assigned` is `true`.
- The LPF contains no active package-pin assignments.
- The debug bridge firmware or MCU host is not identified.
- IO bank voltage compatibility is not proven for the target board.
- Reset polarity is not verified on hardware.
- Clock source and physical oscillator constraint are not bound to a selected board revision.

Required closure:

- Add a release-target FPGA manifest or update `e1_demo_fpga.yaml` only after exact hardware is selected.
- Add concrete LPF constraints and a bitstream build transcript.
- Archive nextpnr/ecppack logs and timing results.
- Keep `product-check` failing until the bitstream release blocker is removed with evidence.

## Check behavior after audit

- `fpga-check` remains a scaffold consistency check: it should pass while still documenting bitstream blockers.
- `padframe-check` remains a scaffold contract check: it should pass while release gates remain blocked.
- `pd-contract-check` remains a manifest/preflight contract check: it should pass when required blocking sections are present.
- `product-check` is now a release-readiness check: it must fail until package, KiCad, FPGA bitstream, and PD signoff blockers are closed.
