# DFT — scan insertion + MBIST + Fault ATPG

This directory owns the e1 manufacturing-test surface:

- `scan_insertion.tcl` — Yosys `scanchain` pass invoked from OpenLane synthesis.
- `mbist.yaml` — Per-SRAM MBIST controller plan keyed to `pd/macros/manifest.yaml`.
- `fault_atpg.config.yaml` — Fault (academic ATPG) hookup config; BLOCKED on
  external tool vendoring.

The DFT gate is `docs/evidence/pd/dft-evidence.yaml`. It fails closed until:

1. `build/dft/e1_chip_top.scan.v` exists and parses.
2. Every macro in `pd/macros/manifest.yaml` has an MBIST controller marked
   `rtl_status: complete_local_evidence`.
3. JTAG boundary scan chain length matches the pad inventory.
4. Fault ATPG (or a commercial equivalent) produces `coverage.json` with
   stuck-at >= 95 %.

## Why this matters

A chip without scan insertion, MBIST, and boundary scan is not testable on
ATE. Skipping DFT at the open-tooling stage means the manufacturing test
program at the foundry has to be reinvented from scratch with commercial
tools — that compresses the schedule slip and is the most common reason
academic open chips taped out without yield.
