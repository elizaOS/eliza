# E1 phone — Interconnect Completeness Audit

**Date:** 2026-05-28
**Evidence class:** `cross_artifact_paper_audit_for_evt_planning_not_measured_hardware`
**Discipline:** electrical-mechanical integration review
**Companion data:** [`interconnect-completeness-audit.json`](./interconnect-completeness-audit.json)

## Claim boundary

This reconciles the electrical block-netlist + BOM against the mechanical CAD
`assembly-manifest.json` (258 parts) and `cad-connection-coverage.json`
(32 modeled CAD connection records, 32/32 passing local marker checks). It is
**not** routed copper, ERC/DRC, a fabricated flex drawing, or a built unit.
`ACCOUNTED` means the high-level interconnect family appears in the electrical
plan **and** has a BOM line **and** has a mechanical representation (a real
part, flex/cable marker, RF-feed marker, or modeled keepout/connector). It does
**not** mean release-ready — most accounted items still carry vendor-drawing
freeze blockers tracked elsewhere.

## Tally

| Status | Count |
|---|---:|
| ACCOUNTED | 19 |
| PARTIAL | 0 |
| MISSING | 0 |
| **Total interconnect families** | **19** |
| CAD connection records | 32 |
| CAD connection records passing local marker checks | 32 |
| Assembly manifest parts | 258 |

ACCOUNTED: display FPC, rear/front camera FPC markers, battery lead flex,
side-key flex, USB-C receptacle, split flex connector pair, development RF feed
envelopes, antenna aperture tuner, bottom speaker, haptic flex, SIM/eSIM marker,
flash LED drive, compute SoM SODIMM connector/keepout markers, 64 CAD
connection terminal markers in `cad-connection-coverage.json`, and the split
PCB island geometry. These are local CAD review representations, not
release-ready supplier drawings.

## Register (summary — full detail in JSON)

| Interconnect | Type | Status | Key gap |
|---|---|---|---|
| Display MIPI-DSI + touch I2C + backlight (40-pin) | FPC + conn | ACCOUNTED | touch controller MPN pending selected display OEM response |
| Rear camera MIPI-CSI (4-lane) | FPC + conn | ACCOUNTED | rear camera FPC tail modeled; supplier FPC/connector drawing still blocked |
| Front camera MIPI-CSI (2-lane) | FPC + conn | ACCOUNTED | front camera FPC tail modeled; supplier FPC/connector drawing still blocked |
| Battery VBAT/GND + NTC + PCM | harness/FPC + conn | ACCOUNTED | battery lead flex modeled; exact connector/strain relief still blocked |
| Side buttons (power + 2× volume) | side-key flex / SMT | ACCOUNTED | side-key flex tail modeled; switch/FPC stack and force-travel evidence blocked |
| USB-C receptacle → PCB | board connector | ACCOUNTED | on bottom island; USB2 must cross split flex |
| Top↔bottom split interconnect (49-contact) | hybrid FPC / B2B | ACCOUNTED | bodies+flex modeled and split board geometry reconciled; MPN/SI/stackup blocked |
| Cellular MAIN antenna feed | RF feed | ACCOUNTED | development feed envelope modeled; supplier antenna/feed validation blocked |
| Cellular DIVERSITY antenna feed | RF feed | ACCOUNTED | development feed envelope modeled; supplier antenna/feed validation blocked |
| Wi-Fi/BT antenna feed | RF feed | ACCOUNTED | RF0/RF1 development feed envelopes modeled; coexistence/feed validation blocked |
| GPS/GNSS antenna feed | RF feed | ACCOUNTED | GNSS development feed envelope modeled; antenna/BOM/validation blocked |
| Aperture tuner (QPC1252Q) RFFE + RF | SMT IC + RFFE | ACCOUNTED | IC modeled+lined; production antenna/contact drawings still blocked |
| Bottom speaker SPK_P/N | spring/solder | ACCOUNTED | bottom speaker lead pair modeled; contact method to freeze with vendor drawing |
| Earpiece receiver | spring/FPC | ACCOUNTED | earpiece lead flex modeled; vendor contact/SPL/leak evidence blocked |
| Microphones ×2 | on-board / FPC | ACCOUNTED | bottom and top mic flex markers modeled; SNR/leak evidence blocked |
| Haptic LRA | wires/FPC | ACCOUNTED | haptic flex tail modeled; driver/preload/first-article evidence blocked |
| SIM / eSIM | tray contacts / solder | ACCOUNTED | SIM/eSIM signal marker modeled; tray/contact MPN and tolerance blocked |
| Flash/torch LED drive (AW36515) | drive lines | ACCOUNTED | LED + driver both BOM-lined; seat/emitter reconciled |
| RK3566 SoM 260-pin SODIMM connector | B2B / SODIMM socket | ACCOUNTED | SODIMM connector and swept daughterboard keepout now modeled; in-enclosure SoM fit remains non-release |

## Reconciliation 1 — SoM vs bare-SoC

- **Mechanical CAD now represents:** the **PATH A SoM carrier interface** with
  `compute_som_sodimm_connector` plus `compute_som_daughterboard_keepout`, while
  the chip-down package markers remain as PATH B cost-down context.
- **Earlier mechanical assumption:** a **bare-SoC chip-down mainboard** (PATH B).
  Single `main_pcb` 64×132×0.8 mm, an 18×16 mm `soc_shield_can` over the SoC, and
  a block-netlist that exposes the full LPDDR4 / UFS / JTAG / boot fanout of a
  bare AP placed directly on the board.
- **BOM ships (default PATH A):** a **turnkey RK3566 SoM** (Firefly
  Core-3566JD4) on a **260-pin gold-finger SODIMM, 0.5 mm pitch** daughterboard;
  the discrete LPDDR/eMMC/PMIC lines are zeroed/folded into the SoM line.
- **Physical fit:** the SoM stack is now CAD-visible but **not release fit
  approved**. A SODIMM module
  + edge socket adds a stacked daughterboard (~3–4 mm Z) the 11.8 mm flush-back
  budget (battery 5.6 + 0.6 swell + display stack + 0.8 board) has no room for,
  unless the final module, socket, and shield stack are re-laid out against the
  screen and battery clearances.
- **Honest resolution:** the missing-CAD contradiction is closed for local
  collision review because the SODIMM connector and daughterboard keepout are
  modeled. It is still not a production release: supplier STEP, exact socket MPN,
  module stack height, insertion clearance, and measured EVT fit remain blockers.

## Reconciliation 2 — split board geometry

- **CAD models:** a split-board `main_pcb` composite: top island 64×29 mm at
  board y=0 and bottom island 64×15 mm at board y=117, matching the KiCad
  `layout-utilization` Edge.Cuts islands. The `split_interconnect` connector
  pair and side flex bridge those two islands.
- **Electrical plan selects:** TWO rigid islands.
  `board-topology-decision.yaml` selects
  `top_bottom_rigid_islands_with_flex_or_board_to_board`; the block-netlist has
  `J_TOP_BOTTOM_FLEX_TOP`/`_BOTTOM` as the 49-contact two-island bridge.
- **Resolution:** the prior single-board contradiction is closed for concept
  CAD. `board-step-readiness.json` reports
  `concept_split_island_geometry_matches_kicad=true`. Release still requires a
  native routed KiCad STEP with supplier component models and measured
  routed-board clearance results.

## Top 3 missing / partial

1. **ACCOUNTED-NON-RELEASE — RK3566 SoM SODIMM connector / daughterboard.** The
   connector and swept daughterboard keepout are now present in CAD, but the
   exact socket/module STEP and measured stack-height fit are still blocked.
2. **ACCOUNTED-NON-RELEASE — flex, cable, and RF marker solids.** Camera,
   battery, side-key, earpiece, microphone, haptic, SIM/eSIM, and RF feed solids
   are now present for local collision review, but controlled-impedance stackups,
   mating connector MPNs, antenna drawings, and first-article measurements are
   still absent.
3. **ACCOUNTED-NON-RELEASE — local markers are not release evidence.**
   Development marker solids do not replace routed copper, supplier STEP/B-rep,
   DRC/ERC/SI/PI/RF signoff, or physical routed-board clearance evidence.
