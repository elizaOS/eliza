# E1 Phone Local Execution Report - 2026-05-28

## Scope

This report captures what was attempted locally for the requested KiCad-to-CAD
closure push. It is non-release evidence unless a downstream gate explicitly
accepts a referenced artifact.

## Local Tool Availability

- `kicad-cli`: not found in `PATH`
- `pcbnew`: not found in `PATH`
- DRC/ERC status: blocked by missing KiCad tooling in this environment
- Existing fail-closed preflight: `mechanical/e1-phone/review/routed-board-kicad-cli-preflight.json`

The repo already records the required DRC/ERC commands:

```bash
kicad-cli pcb drc board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb --format json --output board/kicad/e1-phone/production/reports/drc.json
kicad-cli sch erc board/kicad/e1-phone/schematic/e1-phone.kicad_sch --format json --output board/kicad/e1-phone/production/reports/erc.json
```

These cannot produce release evidence until KiCad CLI is installed in the
release environment and raw reports are archived.

## Existing Local Artifacts

- Project scaffold exists: `board/kicad/e1-phone/e1-phone.kicad_pro`
- Schematic scaffold exists: `board/kicad/e1-phone/schematic/e1-phone.kicad_sch`
- Routed candidate exists: `board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb`
- Local routed STEP candidate exists: `board/kicad/e1-phone/production/step/routed-board-with-components.step`

The routed STEP candidate remains `release_credit=false` because it is based on
development/local geometry, not supplier-approved STEP models, DRC/ERC, or a
production release intake.

## Public Source Findings

- GCT USB4105: manufacturer page exposes a 3D model generator and PCB footprint
  resources; DigiKey also lists CAD models for USB4105 variants.
- Hirose BM28: Hirose product pages expose exact-part STEP downloads for BM28
  variants, including BM28B0.6-44DP/2-0.35V(53).
- Murata Type 2EA: Murata publishes datasheet/land-pattern material and a DXF
  footprint resource for LBEE5XV2EA-802.
- Quectel RG255C: public product/specification pages confirm module family,
  LGA package, dimensions, and interfaces; hardware-design files/STEP may still
  require Quectel document access or direct support.
- Chenghao/display and SincereFirst/camera modules: marketplace/manufacturer
  pages establish buyable module classes, but final FPC pin order, optical
  center, land pattern, and STEP remain supplier-specific.

## Release Blockers

- Supplier-approved package drawings, land patterns, pin order, and STEP models
  are still absent for the release BOM.
- KiCad DRC/ERC cannot run in this environment without KiCad CLI.
- Physical routed-board clearance results are absent; concept CAD boolean
  checks cannot replace supplier BREP plus production routed STEP checks.
- Release intake artifacts remain fail-closed until supplier response packs,
  fab/assembly outputs, raw DRC/ERC, BOM/PnP/Gerbers, and approval signatures
  are populated.

