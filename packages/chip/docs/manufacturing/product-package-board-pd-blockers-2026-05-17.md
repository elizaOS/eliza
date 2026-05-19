# Product Package, Board, and PD Blocker Ledger

Evidence class: `release_blocker_ledger`
Release use: `prohibited`
Generated: 2026-05-17

This ledger records current product-release blockers for package, board,
fabrication, FPGA, physical design, SI/PI, current, and thermal closure. It is
not release evidence and does not unblock fabrication, bitstream, PD, tapeout,
or manufacturing gates.

## KiCad and Board Fabrication

- KiCad sources and dated CLI outputs exist for planning review only.
- Package pinout and footprint remain placeholder planning artifacts.
- Vendor land pattern, package drawing checksum, package revision, and pin-1
  orientation evidence are missing.
- Assembly-house DFM review, stackup/return-path review, and package-board
  cross-probe approval are missing.
- Board SI, PI, current-limit, and thermal evidence are missing.

## FPGA Bitstream

- FPGA target status is still `scaffold`, not `release_ready`.
- Exact FPGA board revision is unassigned.
- LPF pin assignments remain blocked until final pins are assigned.
- Bitstream, nextpnr timing and route reports, ecppack transcript, and FPGA
  tool-version evidence are missing.

## PD and OpenLane Signoff

- No single OpenLane/OpenROAD run contains all required signoff artifacts.
- Final GDS, DEF, gate netlist, SDC, SPEF, SDF, DRC, LVS, antenna, STA,
  utilization, congestion, density/fill, corner manifest, tool versions, and
  signoff run manifest are missing.
- PD release, tapeout release, and board fabrication release remain blocked in
  `pd/signoff/manifest.yaml`.

## Manufacturing, SI/PI, Current, and Thermal

- Package vendor release evidence, bond diagram, material/assembly constraints,
  and package-padframe-board cross-probe approval are missing.
- Board signal-integrity, power-integrity, rail-current budget, and thermal
  review artifacts are missing.
- Manufacturing release manifests must remain fail-closed until these artifacts
  are present, reviewed, checksummed, and marked complete.
