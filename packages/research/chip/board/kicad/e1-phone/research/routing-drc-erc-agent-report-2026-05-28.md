# Routing DRC/ERC Agent Report - 2026-05-28

Lane: KiCad production routing plus DRC/ERC evidence feasibility.

Status: blocked. Current follow-up found a local KiCad CLI extraction at `packages/chip/.tools/kicad-local`, but it is KiCad `7.0.11` and is not sufficient for release DRC/ERC/STEP evidence. The release gate now requires a KiCad CLI capable of `kicad-cli sch erc`, `kicad-cli pcb drc`, and routed-board STEP export from `e1-phone-mainboard-routed.kicad_pcb`.

## Tool Preflight

Command:

```bash
command -v kicad-cli || true
command -v kicad || true
command -v pcbnew || true
command -v eeschema || true
command -v kikit || true
command -v freerouting || true
command -v java || true
```

Original observed result:

```text
/home/shaw/.sdkman/candidates/java/current/bin/java
```

Only Java resolved. No KiCad CLI, KiCad GUI command, KiKit, or freerouting executable resolved. That prevents a real local ERC, DRC, zone-refill, Gerber, drill, IPC, or KiCad STEP export run.

Follow-up observed result:

```text
local kicad-cli: 7.0.11
FAIL: local kicad-cli lacks required release KiCad capability: schematic ERC command
Usage: sch [-h] {export}
```

This changes the blocker from "no KiCad CLI exists" to "the available KiCad CLI is too old for the required release commands and board export smoke test."

The official KiCad CLI documentation shows the relevant command families are `kicad-cli pcb drc`, `kicad-cli sch erc`, and `kicad-cli pcb export step`: https://docs.kicad.org/9.0/en/cli/cli.html

## Local Project State

Found KiCad sources:

```text
packages/chip/board/kicad/e1-phone/e1-phone.kicad_pro
packages/chip/board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb
packages/chip/board/kicad/e1-phone/pcb/e1-phone-mainboard-demo.kicad_pcb
packages/chip/board/kicad/e1-phone/pcb/e1-phone-mainboard-real-footprint-development.kicad_pcb
packages/chip/board/kicad/e1-phone/pcb/e1-phone-mainboard-routed-development.kicad_pcb
packages/chip/board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb
packages/chip/board/kicad/e1-phone/schematic/e1-phone.kicad_sch
```

No `.dsn` or `.ses` autorouter exchange files were found under the checked E1 phone tree.

The project itself is marked non-release:

```json
{"text_variables": {"claim_boundary": "non_release_phone_schematic_scaffold"}}
```

The root schematic is generated and also marked scaffold. It contains this release blocker text:

```text
Other sub-sheets (display_camera, radios, audio_buttons, split_interconnect) remain text scaffolds and are wired in a later pass.
```

## Routed Candidate Findings

Command:

```bash
sha256sum \
  packages/chip/board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb \
  packages/chip/board/kicad/e1-phone/pcb/e1-phone-mainboard-real-footprint-development.kicad_pcb \
  packages/chip/board/kicad/e1-phone/schematic/e1-phone.kicad_sch
```

Observed hashes:

```text
158e862d290ccdac7086130861ca414ea50cfbc00f07c5c46b648d2330a2f59b  e1-phone-mainboard-routed.kicad_pcb
158e862d290ccdac7086130861ca414ea50cfbc00f07c5c46b648d2330a2f59b  e1-phone-mainboard-real-footprint-development.kicad_pcb
e00ee14ca4e49ff754b788ebf534bf141a525b9ae2ed72df2716b7d10c345df5  e1-phone.kicad_sch
```

The routed candidate board is byte-identical to the real-footprint development board. It cannot be treated as an independent production-routed source.

Raw routed candidate counts:

```text
(net 1371
(footprint 89
(segment 306
(via 24
(zone 13
(gr_line 0
(dimension 0
```

This confirms there are local copper segments and vias, but not production release evidence.

## Existing DRC/ERC Files

Existing files:

```text
packages/chip/board/kicad/e1-phone/production/reports/drc.json
packages/chip/board/kicad/e1-phone/production/reports/erc.json
```

Assessment: these are not raw KiCad CLI DRC/ERC reports. Both identify as candidate artifacts:

```text
artifact_id: drc_report_candidate
artifact_id: erc_report_candidate
claim_boundary: Local candidate artifact only. Not supplier, factory, lab, first-article, quote, fabrication, enclosure, or end-to-end release evidence.
```

They include local CAD connection coverage and non-release metadata. I found no `kicad-cli` generator/tool signature or KiCad violation-report payload. They must remain non-release.

## Commands Not Run

These remain not run as release evidence because the available `kicad-cli` is KiCad 7.0.11 and lacks the required commands:

```bash
kicad-cli pcb drc packages/chip/board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb \
  --format json \
  --output packages/chip/board/kicad/e1-phone/production/reports/drc.json

kicad-cli sch erc packages/chip/board/kicad/e1-phone/schematic/e1-phone.kicad_sch \
  --format json \
  --output packages/chip/board/kicad/e1-phone/production/reports/erc.json

kicad-cli pcb export step packages/chip/board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb \
  --output packages/chip/board/kicad/e1-phone/production/step/routed-board-with-components.step
```

I did not overwrite any existing production output paths.

## Promotion Blockers

- No sufficiently new local KiCad CLI/tooling exists to generate real ERC, DRC, zone-refill, export, or KiCad STEP artifacts.
- `e1-phone-mainboard-routed.kicad_pcb` is SHA-identical to `e1-phone-mainboard-real-footprint-development.kicad_pcb`.
- The KiCad project and root schematic are explicitly non-release scaffolds.
- The root schematic still says multiple subsheets are text scaffolds wired in a later pass.
- Existing `drc.json` and `erc.json` are candidate/fail-closed metadata artifacts, not raw KiCad reports.
- The development pad/pin audit still has 13 pending supplier pad-map or pin-order records.
- Selected supplier response packs remain absent for display, cameras, USB-C/side-key, cellular, and Wi-Fi/Bluetooth.
- Production routing still needs approved land patterns, exact pin ordering, route constraints, zone refill, SI/PI/RF validation, release exports, and routed-board clearance rerun from the same checked board hash.

## Next Routing Steps

1. Install the repo-approved KiCad release with `kicad-cli` available in PATH.
   The preflight must pass `python3 scripts/check_kicad_toolchain.py`, including `sch erc`, `pcb drc`, and routed-board STEP export from the current routed board.
2. Resolve the schematic hierarchy and replace remaining text scaffold sheets with real symbols and reviewed pin maps.
3. Replace supplier-pending footprints and pad orders with approved land patterns and STEP/B-rep models.
4. Generate a fresh production board source from the approved schematic netlist.
5. Run ERC and archive raw JSON plus reviewed waivers.
6. Refill zones, save the board revision, run DRC, and archive raw JSON plus reviewed waivers.
7. Export Gerber X2, NC drill/slots, position files, BOM, IPC-2581 or ODB++, and STEP from the same board hash.
8. Run SI/PI/RF/length-skew checks for MIPI, PCIe, UFS, USB2, RF feeds, return paths, and PDN.
9. Rerun enclosure clearance against the routed STEP with supplier component models and attach first-article and fabricator intake evidence.

Release credit: false.
