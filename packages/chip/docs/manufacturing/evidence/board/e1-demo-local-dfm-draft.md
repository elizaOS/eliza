# E1 Demo Local DFM Draft Review

Status: draft local review, not vendor DFM signoff
Board revision: `r0-nonrelease`
KiCad source: `board/kicad/e1-demo`
Fab export: `board/reports/fab/e1-demo-2026-05-17`
Review date: 2026-05-18
Reviewer: local manufacturing preflight
Disposition: blocked for fabrication release

## Scope

This review records locally solvable DFM checks against the non-release KiCad
planning board and dated KiCad CLI export. It does not replace assembly-house
DFM, package-vendor land-pattern approval, or first-article inspection.

Inputs reviewed:

- `board/kicad/e1-demo/e1-demo.kicad_sch`
- `board/kicad/e1-demo/e1-demo.kicad_pcb`
- `board/kicad/e1-demo/e1_demo_planning.pretty/e1_demo_qfn64_planning.kicad_mod`
- `board/reports/fab/e1-demo-2026-05-17/e1-demo-erc-report.txt`
- `board/reports/fab/e1-demo-2026-05-17/e1-demo-drc-report.txt`
- `board/reports/fab/e1-demo-2026-05-17/gerbers/`
- `board/reports/fab/e1-demo-2026-05-17/drill/`
- `board/reports/fab/e1-demo-2026-05-17/e1-demo-bom.csv`
- `board/reports/fab/e1-demo-2026-05-17/e1-demo-position.csv`
- `board/reports/fab/e1-demo-2026-05-17/pdf/e1-demo-fab-drawing.pdf`

## Local Findings

Pass for local draft package:

- KiCad project, schematic, PCB, BOM, position, Gerber, drill, command
  transcript, tool-version transcript, and fab drawing artifacts are archived
  under the dated export directory.
- Board files carry explicit non-release planning markers.
- The SoC footprint is isolated in a project-local planning footprint library.
- BOM line for U1 states that the footprint is a placeholder and must be
  derived from the package drawing before fabrication.

Release blockers:

- U1 footprint is not vendor-derived and has no package drawing checksum.
- No package-vendor courtyard, paste-mask, stencil, exposed-pad, or coplanarity
  limits are archived.
- No assembly-house DFM report is archived.
- No IPC land-pattern calculation or package drawing revision is archived.
- No panelization, fiducial, tooling-hole, or assembly process constraints have
  been accepted by the board vendor.

## Required Release Evidence

- Vendor package drawing and land-pattern source with immutable revision and
  checksum.
- Regenerated KiCad footprint from that source, reviewed against pin-1
  orientation, pad pitch, exposed-pad geometry, solder-mask expansion, paste
  aperture, and courtyard.
- Clean ERC/DRC rerun after footprint regeneration.
- Assembly-house DFM report for the exact Gerber, drill, BOM, position, and fab
  drawing archive intended for purchase.
- Explicit disposition that supersedes this draft local review.
