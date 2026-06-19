# Open PDK Landscape for E1 (2025-2026)

This file evaluates open-source PDKs against the E1 physical-design needs.
The current E1 OpenLane Sky130 PD smoke flow is the baseline. The 2028 14A
target (`docs/spec-db/process-14a-effects.yaml`) is the eventual goal but is
not reachable with any open PDK; this file does not pretend otherwise.

References live in `01_sources/source_inventory.yaml`.

## 1. Sky130 (SkyWater) - current E1 PD smoke target

Repos: `skywater_pdk`, `open_pdks`, `volare`, `klayout_drc_sky130`,
`sky130_io_lib`, `caravel_harness_repo`.

Status for E1:
- Live target in `pd/openlane/config.sky130.json` (`PDK: sky130A`,
  `STD_CELL_LIBRARY: sky130_fd_sc_hd`).
- Volare-pinned PDK revision resolved the OpenLane-compatibility issue
  recorded in `docs/three-week-prototype-workstreams.md`.
- 2026-05-19 release run is clean on DRC and LVS; residual issues are slew
  and capacitance violations (post-route resizer budget), not PDK problems.

Strengths:
- The most mature open PDK. KLayout DRC, Magic DRC, antenna decks, IO
  library, ESD cells, SRAM macros via OpenRAM all exist.
- Caravel harness gives a known-good SoC reference for Sky130 MPW shuttles.

Limitations:
- 130 nm node. Density and frequency targets are far from the E1 14A
  target. Useful as a flow-correctness gate, not as a performance gate.
- Some advanced cells (high-Vt mixes, high-drive flops) are missing or
  limited.

## 2. GF180MCU (GlobalFoundries 180 nm MCU PDK)

Repo: `gf180mcu_pdk`.

Status for E1:
- Not currently used. Worth keeping as a second-source 180 nm node for
  cross-validation if Sky130 ever hits a PDK-specific blocker.
- Caravel harness has a GF180 variant; the OpenROAD flow scripts ship a
  GF180 platform.

Strengths:
- Genuine foundry PDK released under an open license. Higher confidence in
  signoff fidelity for the 180 nm node than predictive PDKs.
- Includes IO and SRAM macros suitable for a real test chip.

Limitations:
- 180 nm. Same density/frequency caveat as Sky130, more so.

## 3. IHP SG13G2 (130 nm BiCMOS)

Repo: `ihp_sg13g2_pdk`.

Status for E1:
- Not currently used. Useful when E1 grows analog/IO content or when a
  second 130 nm node is needed for independent flow correlation.
- Full OpenROAD-flow-scripts support exists.

Strengths:
- BiCMOS - HF analog, ESD options. Relevant for radio or sensor-front-end
  variants of E1.
- Open license, real foundry.

Limitations:
- Different design rule shape from Sky130; not a drop-in alternative.

## 4. ASAP7 (7 nm predictive PDK)

Repo: `asap7_pdk`.

Status for E1:
- Predictive only - no foundry sign off. Useful for sanity-checking that
  E1 RTL maps to a smaller-node cell library without exploding area or
  failing timing trivially.
- Common in ML-PD academic literature; AlphaChip / CircuitNet benchmarks
  often use ASAP7 or NanGate45.

Strengths:
- Realistic 7 nm pin density, cell architecture, and routing layers for
  predictive ML PD work.
- Free, public.

Limitations:
- Not a substitute for any real foundry 7 nm / 5 nm / 14A PDK. No
  signoff path.

## 5. NanGate45 / FreePDK45

Repos: `nangate45_pdk`, `freepdk45_doc`.

Status for E1:
- Standard academic baseline. The most-published PDK in ML-PD literature.
- Useful for E1 in exactly one role: as the "second flow" platform for
  AlphaChip/AutoDMP regression tests, so candidate macro placements can be
  evaluated outside the Sky130 stack to detect PDK-specific bias.

Strengths:
- Cleanly integrated with OpenROAD-flow-scripts.
- Closest match to published ML-PD benchmark conditions.

Limitations:
- Predictive 45 nm. No foundry signoff path. Not useful for E1 tapeout
  claims.

## 6. The 14A gap (2028 target)

`docs/spec-db/process-14a-effects.yaml` correctly declares:

- `selected_process_option: blocked_until_foundry_pdk_and_library_selection`
- `required_status_for_claim: complete_measured_and_signoff_evidence`

No open PDK exists at 14A / 1.4 nm. Recommendations:

- Keep Sky130 / GF180 / IHP130 as the open PD smoke surface.
- Use ASAP7 as the predictive scaling check.
- Treat the 14A signoff path as conditional on a foundry PDK selection.
  The 14A `fail_closed` gate already enforces this.

## 7. PDK recommendation for E1

For the live PD path:

1. Continue with Sky130A + sky130_fd_sc_hd as the primary smoke target.
   `pd/openlane/config.sky130.json` is already correct.
2. Add ASAP7 as the secondary "predictive scaling" flow for AlphaChip /
   AutoDMP candidates. Output is informational, not signoff.
3. Reserve GF180 and IHP130 for second-source / analog/IO variants.
4. Do not claim 14A signoff with any open PDK. The 14A gate already
   prevents this; reaffirm in the implementation plan.

## 8. Padframe and IO

Repos: `sky130_io_lib`, `caravel_harness_repo`. Repo evidence:
`docs/pd/padframe-strategy.md`, `docs/pd/pad-cell-selection-criteria.md`,
`research/alpha_chip_macro_placement/pad-cell-selection-criteria.md`.

The E1 padframe work already references the Sky130 IO library. There is no
open PDK change needed for the IO/ESD path at the Sky130 phase.
