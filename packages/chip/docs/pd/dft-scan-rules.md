# DFT Scan Rules — E1 SoC

Human-readable companion to `pd/dft/scan_rules.yaml`
(`eliza.dft_scan_rules.v1`) and the structured policy
`docs/spec-db/e1-dft-atpg-policy.yaml`. This document records the scan-design
rules a scan-insertion / ATPG flow must respect for the e1 random logic. It
makes no coverage or test-readiness claim; ATPG tooling is not vendored and
the DFT gate (`docs/evidence/pd/dft-evidence.yaml`) fails closed.

## Scan architecture

- **Style:** single internal scan chain. Balanced multi-chain insertion needs
  a commercial DFT compiler; one chain is sufficient for Fault to ingest.
- **Scan ports:** `scan_in`, `scan_en`, `scan_out`. These are **not** present
  in `rtl/` today — Fault (https://github.com/AUCOHL/Fault) threads the chain
  and exposes the ports downstream of the scan-ready leaf netlist
  (`build/dft/*.scan_ready.v`). Top-level scan I/O routes through the JTAG TAP
  (`rtl/dft/e1_jtag_tap.sv`).
- **Test mode:** `TEST_MODE` pin gates the design into scan-shift mode.
- **Test clock:** `CLK_IN` (single clock domain `e1_clk`).

## Clock domains

The e1 SoC is single clock domain — `e1_clk` sourced from `CLK_IN` — per
`docs/spec-db/e1-clock-reset-domain-intent.yaml`. The scan test clock is
`CLK_IN`; every scan flop is on this domain, so no on-chip clock-domain
crossing complicates shift.

## Asynchronous resets

- `RST_N`: external active-low async reset, synchronized by
  `rtl/clock/e1_reset_sync.sv::e1_reset_sync`.
- `rst_n_sync`: the synchronized active-low reset that fans out to the logic.

Both resets are held **inactive** during scan shift so reset does not corrupt
the shifting chain state.

## No-scan cells

- **Clock-gating cells:** excluded; the test clock must reach every scan flop.
- **Reset synchronizer flops** (`e1_reset_sync`): CDC synchronizers are
  excluded from the scan chain.
- **SRAM macro internal flops:** covered by MBIST (`pd/dft/mbist.yaml`), not
  scan.

## X-sources

- **Uninitialized SRAM:** OpenRAM macros are unbuilt; their outputs are X at
  shift start and must be MBIST-initialized or scan-isolated. BLOCKED until
  the OpenRAM macros land.
- **JTAG TAP unclocked inputs:** `JTAG_TDI` / `JTAG_TMS` constrained at the
  ATPG boundary.
- **Bidirectional pads:** X-handling BLOCKED on the unfinalized pad inventory.

## Per-node status

| node | scan status | std-cell library |
| --- | --- | --- |
| sky130 | scan-capable library present (validated on leaf) | `sky130_fd_sc_hd` |
| gf180 | scan-capable library present (not exercised) | `gf180mcu_fd_sc_mcu7t5v0` |
| ihp-sg13g2 | scan capability unverified | `sg13g2_stdcell` |
| asap7 | predictive shape only, not fabricable | `asap7sc7p5t` |
| tsmc-n2p / tsmc-a14 / intel-14a / samsung-sf2p | BLOCKED (NDA PDK) | n/a |

Only sky130 has an exercised scan-prep path (`pd/dft/scan_insertion.tcl` via
`pd/dft/run_e1_bootrom_scan_prep.tcl`). All advanced NDA nodes stay BLOCKED
until foundry PDK and DFT-kit access is in place; no scan rule or coverage is
asserted for them.

## Release blockers

1. Scan ports not present in `rtl/`; Fault stitches them and Fault is not
   vendored under `external/`.
2. SRAM X-sources require MBIST init (BLOCKED in `pd/dft/mbist.yaml`).
3. Bidirectional pad X-handling BLOCKED on the unfinalized pad inventory.
