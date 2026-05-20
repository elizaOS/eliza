# Eliza E1 phone mainboard — KiCad concept package

Date: 2026-05-20
Status: concept_only. Non-release schematic scaffold and concept PCB exist.
No reviewed schematic, routed PCB, ERC/DRC-clean layout, or fabrication output
exists.

Claim boundary: This directory contains a KiCad-compatible planning package
for the phone mainboard. The schematic files are text scaffolds generated from
the logical block netlist; the PCB is an unrouted placement/floorplan concept.
Promotion requires real supplier pinouts, symbols, footprints, ERC, routed
layout, IPC-2581/Gerbers, STEP, BOM generation via KiBot, DRC clean,
IBIS-AMI/SI review, RF review, thermal review, and a fabricated board.

## Intent

Mirror the layout of MNT Reform's `mainboard/` and PinePhone Pro's
`pinephone-pro-mainboard/` open-hardware repos:

```
board/kicad/e1-phone/
  schematic/         # KiCad schematic scaffold sheets (.kicad_sch)
  pcb/               # KiCad concept PCB/floorplan (.kicad_pcb)
  library/           # Project-local symbol + footprint + 3D libraries
  production/        # Fabrication outputs (Gerbers, IPC-2581, BOM, STEP)
  kibot.yaml         # Automation config for production outputs
  README.md          # This file
```

## kibot.yaml plan

The committed `kibot.yaml` is a skeleton and is not release evidence. Outputs
planned:

- `gerbers/`: standard Gerber X2 set + drill files for an 8-layer 0.8 mm board.
- `ipc-2581/`: IPC-2581 Revision C package (manufacturer-neutral fabrication).
- `bom/`: Interactive HTML BOM + iBOM + CSV BOM with vendor PNs.
- `step/`: Mechanical 3D model for case integration review.
- `pos/`: Pick-and-place CSV for SMT assembly.
- `pdf/`: schematic PDF + layout PDF for review.

See `kibot.yaml` in this directory.

## Linked bindings

The mainboard schematic, when written, must consume these planning
bindings as authoritative:

- `package/e1-demo-pinout.yaml` — SoC pinout (when bonded out beyond the
  QFN64 demo).
- `package/wifi/murata-1dx-sdio.yaml` — Wi-Fi/BT module.
- `package/wifi/murata-type-2ea-wifi6e.yaml` — phone-class Wi-Fi 6E/BT target.
- `package/cellular/quectel-5g-redcap.yaml` — first-phone cellular module target.
- `package/display/v0-dsi-720x1280.yaml` — DSI panel.
- `package/camera/oem-mipi-csi-modules.yaml` — rear/front camera module targets.
- `package/pmic/da9063.yaml` — PMIC.
- `package/usb-pd/tps65987.yaml` — USB-PD controller.
- `package/usb-c/e1-phone-usb-c-port.yaml` — one bottom USB-C receptacle
  strategy and connector shortlist.
- `package/human-interface/side-buttons.yaml` — power and volume button
  switch/flex constraints.
- `package/charger/max77860.yaml` — Charger.
- `package/battery/e1-phone-17p3wh-pack.yaml` — battery pack connector,
  thermistor/ID, safety-document, and enclosure compression requirements.
- `package/sensors/v0-sensors.yaml` — Sensors.
- `package/audio/v0-codec.yaml` — Audio codec + amp + mics.
- `docs/board/power-tree.md` — Rail-by-rail PDN intent.
- `docs/board/pdn-budget.md` — PDN target-impedance budget.
- `docs/board/antenna-plan.md` — Antenna placement and isolation.
- `docs/board/thermal-stack.md` — Mainboard thermal stack.

## What this is not

- This is not a production KiCad project. The schematic scaffold is text-only
  logical net documentation, not reviewed symbols or supplier pinouts.
- This is not a routed PCB. The concept board has outline, keepouts, labels,
  and placement regions only.
- This is not a fabricated board. None of the parts in the bindings above are
  bonded into an ERC/DRC-clean design.
- This is not a release. Treat as a fail-closed planning package.

## Concept planning package

The current phone-mainboard planning package is intentionally separate from
fabrication evidence:

- `docs/board/e1-phone-mainboard-end-to-end.md` — end-to-end closure plan
  for a complete phone mainboard.
- `docs/board/e1-phone-mainboard-metrics.yaml` — concept area, wasted-space,
  power-efficiency, and connectivity targets.
- `docs/board/e1-phone-oem-sourcing.md` — Alibaba/Made-in-China/vendor
  sourcing baseline for display, cameras, cellular, and Wi-Fi/Bluetooth.
- `board/kicad/e1-phone/supplier-sourcing-audit.yaml` — current public
  supplier audit for the 5.5 inch display anchor, camera module class,
  Quectel RedCap module, and Murata Wi-Fi/Bluetooth module. It is not an AVL
  or supplier approval.
- `board/kicad/e1-phone/preview/e1-phone-mainboard-floorplan.svg` — CAD-style
  floorplan preview.
- `board/kicad/e1-phone/preview/e1-phone-mainboard-floorplan.png` — rendered
  screenshot of the preview.
- `board/kicad/e1-phone/preview/floorplan-html-screenshot.png` — Chrome
  headless screenshot proving the HTML preview renders.
- `board/kicad/e1-phone/preview/e1-phone-mainboard-pcb-render.svg` — PCB-style
  top-side concept render.
- `board/kicad/e1-phone/preview/e1-phone-mainboard-pcb-render.png` — rendered
  screenshot of the PCB-style preview.
- `board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb` — minimal
  KiCad PCB concept file with board outline, stackup placeholder, keepouts,
  top-side placement boxes, and generated non-release placeholder footprints
  for the major modules, test points, fiducials, and mounting holes. It is not
  routed fabrication data.
- `board/kicad/e1-phone/e1-phone.kicad_pro` — KiCad project scaffold.
- `board/kicad/e1-phone/schematic/*.kicad_sch` — generated hierarchical
  schematic scaffold sheets for power/USB, compute, display/cameras, radios,
  audio, and side buttons. These sheets are non-release logical-net evidence.
- `board/kicad/e1-phone/preview/schematic/e1-phone.svg` and `.png` — KiCad
  CLI schematic export proving the scaffold opens and renders.
- `board/kicad/e1-phone/placement-interface-matrix.yaml` — board-region,
  external module, and net-interface matrix for schematic/layout closure.
- `board/kicad/e1-phone/block-netlist.yaml` — logical block netlist for the
  display, cameras, USB-C, PMIC/charger, cellular, Wi-Fi/BT, buttons, and
  audio before real KiCad schematic capture.
- `board/kicad/e1-phone/display-fit.yaml` — generated 2D display/enclosure
  fit report for the selected 5.5 inch Chenghao-class CTP module. It enforces
  the 78.0 x 153.6 mm device envelope used to contain the 77.1 x 151.77 mm
  module outline with margin.
- `board/kicad/e1-phone/enclosure-placement-closure.yaml` — generated
  cross-check tying the concept PCB outline, display fit, mechanical overlay,
  STEP envelope artifacts, fit report, and clearance report together. It is
  not final enclosure release evidence because the board STEP is not from a
  routed KiCad board with final component models.
- `board/kicad/e1-phone/interface-closure.yaml` — generated cross-check tying
  USB-C, side buttons, display/touch FPC, and camera FPCs to package bindings,
  placement regions, logical nets, and release blockers.
- `board/kicad/e1-phone/power-thermal-budget.yaml` — generated cross-check
  tying the USB-C PD sink, charger, PMIC rails, battery target, runtime targets,
  and thermal skin limit to the logical block netlist. It remains blocked on
  real schematic, PI, thermal simulation, and measurements.
- `board/kicad/e1-phone/rf-connectivity-closure.yaml` — generated cross-check
  tying Quectel RedCap cellular, Murata Wi-Fi 6E/Bluetooth, RF matching nets,
  antenna keepouts, enclosure RF constraints, and measurement blockers.
- `board/kicad/e1-phone/pinout-footprint-freeze.yaml` — generated supplier
  pinout, footprint, and mechanical-data freeze matrix for display, cameras,
  USB-C, side buttons, cellular, battery, Wi-Fi/BT, audio, speakers, and mics.
  It keeps the PCB blocked until exact supplier evidence exists.
- `board/kicad/e1-phone/audio-acoustic-closure.yaml` — generated cross-check
  for audio codec, smart amp, two PDM microphones, speaker outputs, haptic
  actuator, bottom speaker/mic gasket constraints, top earpiece/RF separation,
  and required acoustic measurements.
- `board/kicad/e1-phone/routing-constraints.yaml` — impedance, length,
  keepout, RF, PI, and mechanical routing constraints for the future PCB.
- `board/kicad/e1-phone/layout-utilization.yaml` — geometry-derived
  utilization report from the concept KiCad PCB. It computes the 64 x 132 mm
  outline, 64 x 87 mm full-width battery cavity, antenna keepouts, F.Fab placement
  rectangles, and remaining route/shield/test reserve. It is intentionally
  concept-only and must be replaced by real footprint/courtyard utilization.
- `board/kicad/e1-phone/preliminary-bom.yaml` — preliminary sourcing/BOM
  shortlist, not an AVL or production BOM.
- `board/kicad/e1-phone/manufacturing-closure.yaml` — fail-closed list of
  missing fabrication, assembly, test, DFM/DFA, fab-quote, and first-article
  evidence required before release.
- `board/kicad/e1-phone/artifact-manifest.yaml` — fail-closed board package
  manifest defining what is present and what blocks release.
- `board/kicad/e1-phone/preview/kicad-cli-mainboard.svg` — KiCad CLI export
  from the concept PCB, generated with `make kicad-phone-render`.
- `board/kicad/e1-phone/preview/kicad-cli-mainboard.png` — rasterized copy
  of the KiCad CLI export, also checked by `make kicad-phone-preview-check`.
- `board/kicad/e1-phone/preview/e1-phone-enclosure-fit.svg` — enclosure fit
  preview for display, board, battery, USB-C, camera, and side buttons.
- `board/kicad/e1-phone/preview/e1-phone-enclosure-fit.png` — rendered
  screenshot of the enclosure fit preview.

## Verification

- `make kicad-setup` — installs host KiCad packages when root/passwordless
  sudo is available; otherwise installs a user-local KiCad toolchain under
  `.tools/kicad-local`; Docker remains a fallback when local extraction is
  unavailable.
- `make e1-phone-schematic-scaffold` — regenerates the KiCad schematic
  scaffold from `board/kicad/e1-phone/block-netlist.yaml`.
- `make e1-phone-layout-metrics` — regenerates
  `board/kicad/e1-phone/layout-utilization.yaml` from the concept KiCad PCB
  geometry.
- `make e1-phone-pcb-footprint-scaffold` — regenerates placeholder KiCad
  footprints, required power test points, global fiducials, and mounting-hole
  references inside the concept PCB. These are excluded from BOM/PnP and must
  be replaced by supplier land patterns before release.
- `make e1-phone-display-fit` — regenerates
  `board/kicad/e1-phone/display-fit.yaml` from the selected display binding,
  metrics, and enclosure interface.
- `make e1-phone-interface-closure` — regenerates
  `board/kicad/e1-phone/interface-closure.yaml` from enclosure-facing package
  bindings, placement regions, and the logical block netlist.
- `make e1-phone-enclosure-placement` — regenerates
  `board/kicad/e1-phone/enclosure-placement-closure.yaml` from the generated
  mechanical CAD review artifacts, display fit, and KiCad mechanical overlay.
- `make e1-phone-power-thermal` — regenerates
  `board/kicad/e1-phone/power-thermal-budget.yaml` from the battery, USB-C,
  charger, PMIC, display, camera, radio, audio, and thermal planning bindings.
- `make e1-phone-rf-connectivity` — regenerates
  `board/kicad/e1-phone/rf-connectivity-closure.yaml` from cellular/Wi-Fi
  bindings, RF routing constraints, antenna keepouts, and enclosure rules.
- `make e1-phone-supplier-sourcing-audit` — regenerates
  `board/kicad/e1-phone/supplier-sourcing-audit.yaml` from the current package
  bindings, metrics, and public sourcing evidence captured on 2026-05-20.
- `make e1-phone-pinout-footprint-freeze` — regenerates
  `board/kicad/e1-phone/pinout-footprint-freeze.yaml` from the BOM, placement
  matrix, logical block netlist, and routing constraints.
- `make e1-phone-audio-acoustic` — regenerates
  `board/kicad/e1-phone/audio-acoustic-closure.yaml` from the audio binding,
  enclosure constraints, routing rules, mechanical overlay, and supplier freeze
  record.
- `make e1-phone-manufacturing-closure` — regenerates
  `board/kicad/e1-phone/manufacturing-closure.yaml` from the manifest, KiBot
  skeleton, concept PCB, routing constraints, and utilization report.
- `make e1-phone-board-package-check` — validates the manifest, sourcing
  bindings, placement matrix, preliminary BOM, optimized board dimensions,
  geometry-derived utilization, manufacturing closure, schematic scaffold,
  concept KiCad file, and fail-closed release gates.
- `make kicad-phone-render` — exports the concept PCB through KiCad CLI and
  verifies all preview PNG/SVG artifacts are nonblank and parseable.

## Open decisions

1. SoM vs mainboard split (MNT Pocket Reform pattern) per
   `research/mobile_platform_2026/03_implementation/platform_path_for_e1.md`
   M-4: "Document `package/som-vs-mainboard-split.md`."
2. Board outline / mechanical envelope (depends on case selection).
3. Layer stack-up: 8L 0.8 mm vs 10L 0.6 mm vs HDI 12L (cost vs density).
