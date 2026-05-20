# Eliza E1 phone mainboard — KiCad project skeleton

Date: 2026-05-19
Status: skeleton_only. No schematic. No PCB layout. No fabrication.

Claim boundary: This directory is a placeholder for the eventual KiCad 9
project. No schematic / PCB layout / Gerber output exists. Promotion
requires schematic, layout, IPC-2581 + STEP + BOM generation via kibot, DRC
clean, IBIS-AMI SI simulation, and a fabricated board.

## Intent

Mirror the layout of MNT Reform's `mainboard/` and PinePhone Pro's
`pinephone-pro-mainboard/` open-hardware repos:

```
board/kicad/e1-phone/
  schematic/         # KiCad 9 schematic sheets (.kicad_sch)
  pcb/               # KiCad 9 PCB layout (.kicad_pcb)
  library/           # Project-local symbol + footprint + 3D libraries
  production/        # Fabrication outputs (Gerbers, IPC-2581, BOM, STEP)
  kibot.yaml         # Automation config for production outputs
  README.md          # This file
```

## kibot.yaml plan

The committed `kibot.yaml` is a skeleton; it does not yet point at any
schematic or PCB file because those do not exist. Outputs planned:

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
- `package/display/v0-dsi-720x1280.yaml` — DSI panel.
- `package/pmic/da9063.yaml` — PMIC.
- `package/usb-pd/tps65987.yaml` — USB-PD controller.
- `package/charger/max77860.yaml` — Charger.
- `package/sensors/v0-sensors.yaml` — Sensors.
- `package/audio/v0-codec.yaml` — Audio codec + amp + mics.
- `docs/board/power-tree.md` — Rail-by-rail PDN intent.
- `docs/board/pdn-budget.md` — PDN target-impedance budget.
- `docs/board/antenna-plan.md` — Antenna placement and isolation.
- `docs/board/thermal-stack.md` — Mainboard thermal stack.

## What this is not

- This is not a working KiCad project. Opening this directory in KiCad 9
  shows an empty project.
- This is not a fabricated board. None of the parts in the bindings above
  are bonded into a working schematic or PCB.
- This is not a release. Treat as a forward planning placeholder.

## Concept planning package

The current phone-mainboard planning package is intentionally separate from
fabrication evidence:

- `docs/board/e1-phone-mainboard-end-to-end.md` — end-to-end closure plan
  for a complete phone mainboard.
- `docs/board/e1-phone-mainboard-metrics.yaml` — concept area, wasted-space,
  power-efficiency, and connectivity targets.
- `board/kicad/e1-phone/preview/e1-phone-mainboard-floorplan.svg` — CAD-style
  floorplan preview.
- `board/kicad/e1-phone/preview/e1-phone-mainboard-floorplan.png` — rendered
  screenshot of the preview.

## Open decisions

1. SoM vs mainboard split (MNT Pocket Reform pattern) per
   `research/mobile_platform_2026/03_implementation/platform_path_for_e1.md`
   M-4: "Document `package/som-vs-mainboard-split.md`."
2. Board outline / mechanical envelope (depends on case selection).
3. Layer stack-up: 8L 0.8 mm vs 10L 0.6 mm vs HDI 12L (cost vs density).
