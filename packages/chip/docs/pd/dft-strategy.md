# DFT Strategy — Scan + MBIST + JTAG Boundary Scan

## Scope

The e1 manufacturing-test surface spans three concerns: scan insertion for
the random logic, MBIST for the SRAM macros, and JTAG boundary scan for the
pads. This document records the strategy across all three and is the
human-readable companion to `docs/evidence/pd/dft-evidence.yaml`.

## Scan insertion (random logic)

- **Tool:** Yosys for standard FF mapping (prep only) + Fault DFT pass for the
  actual scan-flop substitution and chain stitching. Upstream Yosys does NOT
  ship a `scanchain` macro pass, and `dfflibmap` does NOT retarget to scan
  cells -- it maps each D-FF onto the best-matching *ordinary* library flop
  (e.g. `sky130_fd_sc_hd__dfrtp_1`), not a `sky130_fd_sc_hd__sdfxxx` mux-D scan
  flop. The earlier draft of `pd/dft/scan_insertion.tcl` that referenced a
  `scanchain` command is BLOCKED and the gate fails closed. The real
  open-source path is:
  1. `yosys -p "synth_sky130 -top <mod>"` (or `pd/dft/scan_insertion.tcl`) to
     map combinational logic and D-FFs onto ordinary `sky130_fd_sc_hd` cells.
     This is preparation only; the result still contains non-scan flops.
  2. `fault.py dft -top <mod>` (https://github.com/AUCOHL/Fault) to perform the
     scan-flop substitution (producing `sky130_fd_sc_hd__sdfxxx` cells), thread
     the scan chain, expose `scan_in`/`scan_en`/`scan_out` ports, and emit the
     STIL/VCD harness. Fault is not vendored under `external/`, so this step is
     BLOCKED; `scripts/build_scan_chain_contract.py` fails closed when the
     netlist contains no `sdf*` scan flops rather than inventing a chain.
- **Configuration:** Single scan chain. Top-level scan ports route to the
  pad ring through the JTAG TAP `IEEE 1149.1` USERCODE-style instruction.
- **Fault model:** stuck-at + transition-delay.
- **Coverage target:** 95 % stuck-at, 85 % transition-delay (academic
  open-source ATPG baseline).

A single chain is intentional at this stage: balanced multi-chain insertion
needs a commercial DFT compiler. A single long chain is enough for Fault
to ingest.

## MBIST (SRAM macros)

- **Per-macro controller:** Each OpenRAM-generated SRAM macro in
  `pd/macros/manifest.yaml` has a corresponding MBIST controller entry in
  `pd/dft/mbist.yaml`. Controllers are BLOCKED on the OpenRAM macros
  themselves landing.
- **Patterns:** March-C-, March-LR, March-SU per macro, plus checkerboard
  for the 64 KB block.
- **Failure log:** per-macro words sized to the macro depth so a single
  failure trace fits in one MBIST run.
- **Access:** every MBIST controller is reachable via JTAG using the chain
  IDs listed in `mbist.yaml`.

## JTAG boundary scan (pads)

- **TAP module:** `e1_jtag_tap`. IR width 5 bits.
- **Boundary register width:** depends on the final pad inventory. BLOCKED
  until pad cell selection completes (`docs/pd/pad-cell-selection-criteria.md`).
- **Standard:** IEEE 1149.1 compatible TAP state machine, EXTEST and INTEST
  exercised by the manufacturing test program.

## Fault ATPG hookup

Fault is the academic ATPG tool that consumes scan-inserted Verilog plus the
standard-cell Liberty and produces stuck-at and transition-delay patterns in
STIL format. Today Fault is **not** vendored under `external/`; the
`pd/dft/fault_atpg.config.yaml` records the contract so the gate fails
closed.

## Why the open-tooling DFT pass matters now

A 2028 tapeout without a vetted scan/MBIST/JTAG plan is a yield disaster.
The most common reason an academic open chip tapes out without manufacturing
test is that DFT was deferred to the commercial-tool phase, which then ran
out of schedule. Doing scan insertion and MBIST planning on the Sky130
release flow now means the manufacturing test program at the foundry is a
port, not a fresh design.

## What unblocks the dft-evidence gate

1. OpenRAM Sky130 macros land in `pd/macros/sky130/`.
2. Per-macro MBIST controllers generated; `mbist.yaml` entries flip to
   `complete_local_evidence`.
3. `scan_insertion.tcl` runs cleanly through Yosys in the OpenLane synthesis
   stage and produces `build/dft/e1_chip_top.scan.v`.
4. Fault (or commercial ATPG) emits `coverage.json` >= 95 % stuck-at.
5. Boundary scan chain length matches the pad inventory.
