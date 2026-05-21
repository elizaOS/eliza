# E1 phone — Interconnect Completeness Audit

**Date:** 2026-05-21
**Evidence class:** `cross_artifact_paper_audit_for_evt_planning_not_measured_hardware`
**Discipline:** electrical-mechanical integration review
**Companion data:** [`interconnect-completeness-audit.json`](./interconnect-completeness-audit.json)

## Claim boundary

This reconciles the electrical block-netlist + BOM against the mechanical CAD
`assembly-manifest.json` (123 parts). It is **not** routed copper, ERC/DRC, a
fabricated flex drawing, or a built unit. `ACCOUNTED` means the interconnect
appears in the electrical plan **and** has a BOM line **and** has a mechanical
representation (a real part, or a modeled keepout/connector). It does **not**
mean release-ready — most accounted items still carry vendor-drawing freeze
blockers tracked elsewhere.

## Tally

| Status | Count |
|---|---:|
| ACCOUNTED | 6 |
| PARTIAL | 9 |
| MISSING | 3 |
| **Total interconnects** | **18** |

ACCOUNTED: display FPC, USB-C receptacle, antenna aperture tuner, bottom
speaker, flash LED drive, top↔bottom split flex connector pair *(connector
bodies modeled + allocated; see split-board caveat)*.

## Register (summary — full detail in JSON)

| Interconnect | Type | Status | Key gap |
|---|---|---|---|
| Display MIPI-DSI + touch I2C + backlight (40-pin) | FPC + conn | ACCOUNTED | touch controller MPN TBD |
| Rear camera MIPI-CSI (4-lane) | FPC + conn | PARTIAL | no FPC tail / board CSI connector in CAD; only module body |
| Front camera MIPI-CSI (2-lane) | FPC + conn | PARTIAL | no FPC tail / connector in CAD |
| Battery VBAT/GND + NTC + PCM | harness/FPC + conn | PARTIAL | no mating board connector or harness geometry in CAD |
| Side buttons (power + 2× volume) | side-key flex / SMT | PARTIAL | switch bodies + side-key flex absent; sit in battery zone |
| USB-C receptacle → PCB | board connector | ACCOUNTED | on bottom island; USB2 must cross split flex |
| Top↔bottom split interconnect (49-contact) | hybrid FPC / B2B | PARTIAL | bodies+flex modeled but MPN/SI/stackup blocked; contradicts single main_pcb |
| Cellular MAIN antenna feed | RF feed | PARTIAL | keepout only, no feed point modeled |
| Cellular DIVERSITY antenna feed | RF feed | PARTIAL | no distinct element / feed |
| Wi-Fi/BT antenna feed | RF feed | PARTIAL | keepout only, no feed point |
| GPS/GNSS antenna feed | RF feed | **MISSING** | CELL_GNSS_RF routed but no element/keepout/feed/BOM line |
| Aperture tuner (QPC1252Q) RFFE + RF | SMT IC + RFFE | ACCOUNTED | IC modeled+lined; relies on (unmodeled) antenna feed |
| Bottom speaker SPK_P/N | spring/solder | ACCOUNTED | contact method to freeze with vendor drawing |
| Earpiece receiver | spring/FPC | PARTIAL | top-mounted; lead to bottom-island codec unmodeled; no distinct net |
| Microphones ×2 | on-board / FPC | PARTIAL | top mic PDM flex to bottom codec unmodeled |
| Haptic LRA | wires/FPC | PARTIAL | LRA lead not a discrete part; driver location unpinned |
| SIM / eSIM | tray contacts / solder | PARTIAL | contact holder + contact-to-modem flex not modeled |
| Flash/torch LED drive (AW36515) | drive lines | ACCOUNTED | LED + driver both BOM-lined; seat/emitter reconciled |
| RK3566 SoM 260-pin SODIMM connector | B2B / SODIMM socket | **MISSING** | BOM ships SoM; CAD+netlist model bare-SoC; no socket, no daughterboard, no Z-budget |

## Reconciliation 1 — SoM vs bare-SoC

- **Mechanical CAD assumes:** a **bare-SoC chip-down mainboard** (PATH B).
  Single `main_pcb` 64×132×0.8 mm, an 18×16 mm `soc_shield_can` over the SoC, and
  a block-netlist that exposes the full LPDDR4 / UFS / JTAG / boot fanout of a
  bare AP placed directly on the board.
- **BOM ships (default PATH A):** a **turnkey RK3566 SoM** (Firefly
  Core-3566JD4) on a **260-pin gold-finger SODIMM, 0.5 mm pitch** daughterboard;
  the discrete LPDDR/eMMC/PMIC lines are zeroed/folded into the SoM line.
- **Physical fit:** the SoM does **not** fit the current model. A SODIMM module
  + edge socket adds a stacked daughterboard (~3–4 mm Z) the 11.8 mm flush-back
  budget (battery 5.6 + 0.6 swell + display stack + 0.8 board) has no room for,
  and the modeled `soc_shield_can` (18×16) is nothing like a ~67–70 mm SODIMM
  finger edge. The SoM is mechanically **unmodeled and unbudgeted**.
- **Honest resolution:** the mechanical CAD is a **chip-down (PATH B) model**.
  PATH A (SoM) is the buildable-now / no-NDA bring-up electrical path but is
  **bench/breadboard-only** against this enclosure. Production target =
  **chip-down bare RK3566** (needs the NDA ball-map). Either tag PATH A as
  out-of-enclosure EVT-bench, or re-spec the enclosure + add a SODIMM socket CAD
  part and a consistent stack. Current state is **inconsistent** between BOM and
  mechanical model and should be called out as such.

## Reconciliation 2 — single board vs split board

- **CAD models:** ONE continuous board — `main_pcb` is a single 64×132 mm
  rectangle spanning Y −66…+66 — **plus** a `split_interconnect` set
  (top connector at Y≈+37, bottom connector at Y≈−52, side flex bridging
  Y −51.5…+36.5 along the +X edge).
- **Electrical plan selects:** TWO rigid islands.
  `board-topology-decision.yaml` selects
  `top_bottom_rigid_islands_with_flex_or_board_to_board`; the block-netlist has
  `J_TOP_BOTTOM_FLEX_TOP`/`_BOTTOM` as the 49-contact two-island bridge.
- **Contradiction:** a single continuous board does not need a top↔bottom flex.
  The manifest carries both a one-piece `main_pcb` and the split-island flex.
- **Honest resolution:** intended topology is **two rigid islands** joined by the
  49-contact flex (battery occupies the full-width center). The single
  `main_pcb` is a **stale placeholder not yet cut** to the selected split
  topology. Fix: split `main_pcb` into `top_island` and `bottom_island` parts in
  CAD to match the electrical plan and the flex that is already modeled. Until
  then the board geometry contradicts the interconnect plan.

## Top 3 missing / partial

1. **MISSING — RK3566 SoM SODIMM connector / daughterboard.** Largest gap: BOM
   default ships a 260-pin SODIMM SoM, but CAD + netlist model a bare-SoC
   chip-down board with no socket, no daughterboard, and no stacked-Z budget.
2. **MISSING — GNSS antenna feed.** `CELL_GNSS_RF` is routed from the modem but
   there is no GNSS antenna element, keepout, feed point, or distinct BOM line.
3. **PARTIAL — antenna feed points + discrete component flexes.** Cellular
   main/diversity and Wi-Fi/BT feed points are BOM-named but modeled only as
   keepout volumes (no spring/coax/laser-direct feed part); and the
   rear/front-camera FPC tails, battery harness + board connector, side-key
   flex, top-mic PDM flex, earpiece lead, and SIM contact flex are all
   BOM-named but absent as CAD parts. The mechanical FPC/feed routing layer is
   largely missing from the manifest — modules and keepouts exist, the wires
   between them mostly do not.
