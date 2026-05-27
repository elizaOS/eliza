# E1 demo KiCad fabrication note

Evidence class: `non_release_demo_planning`
Release status: `blocked`
Fabrication release: `prohibited`
Release credit: `none`

This file records the current E1 demo board state for review traceability only.
It does not authorize board fabrication, assembly, enclosure integration,
first-article bring-up, phone end-to-end claims, or product-release credit.

## Current Source Artifacts

- KiCad project source:
  `board/kicad/e1-demo/e1-demo.kicad_pro`
- KiCad schematic source:
  `board/kicad/e1-demo/e1-demo.kicad_sch`
- KiCad PCB source:
  `board/kicad/e1-demo/e1-demo.kicad_pcb`
- Local review footprint source:
  `board/kicad/e1-demo/e1_demo_planning.pretty/e1_demo_qfn64_planning.kicad_mod`
- Artifact manifest:
  `board/kicad/e1-demo/artifact-manifest.yaml`
- Pinout cross-probe record:
  `docs/board/kicad/e1-demo/package-pinout-cross-probe.yaml`
- Dated CLI output directory:
  `board/reports/fab/e1-demo-2026-05-17/`

The dated CLI outputs are inventory and diagnostic records. They do not carry
release credit unless the artifact manifest, command transcript, tool versions,
ERC, DRC, fabrication outputs, and review records are all promoted with
release-approved evidence.

## Exact Non-Release Status

- Foundry approval: `missing`
- Package-vendor land-pattern approval: `missing`
- Package drawing immutable revision and checksum: `missing`
- Bond diagram release: `missing`
- Foundry pad-cell, ESD, seal-ring, and package-interface rule binding:
  `missing`
- Assembly-house DFM approval: `missing`
- Board-house stackup, impedance, drill, annular-ring, solder-mask, and
  fabrication capability approval: `missing`
- Footprint is not derived from a package vendor drawing.
- No SI/PI analysis has been performed.
- SI/PI and PDN review approval: `missing`
- Enclosure mechanical fit approval using released board STEP and component
  heights: `missing`
- Released BOM, AVL, placement, and assembly package: `missing`
- First-article test traveler, executed logs, and disposition: `missing`

The local QFN64 footprint and package assumptions are review-only inputs. They
are not derived from an approved package-vendor drawing and must not be used as
the basis for fabrication.

## Required Evidence Before Release Credit

Fabrication release remains blocked until all of the following exist and are
reviewed in the artifact manifest:

- Approved foundry/package documentation with immutable revision identifiers
  and checksums.
- Approved package-vendor land pattern or a reviewed derivation record tied to
  the package drawing.
- Checked schematic and PCB sources bound to the approved package, pad, ESD,
  rail-current, and signal-integrity assumptions.
- Clean ERC and DRC reports from a recorded KiCad tool version and command
  transcript.
- Reviewed Gerber, drill, fabrication drawing, BOM, position, and assembly
  outputs.
- Board-house and assembly-house DFM responses with disposition of every issue.
- Stackup, impedance, return-path, PDN, thermal/current-limit, and SI/PI review
  records.
- Enclosure-fit evidence from released STEP output and component-height data.
- First-article build, bench bring-up, and test logs showing the board meets
  the release criteria in
  `docs/manufacturing/physical-closure-work-order.yaml`.

## Bring-Up Intent After Release

These steps are intent only and do not reduce the release evidence required
above:

1. Current-limit both rails.
2. Confirm `1.8 V` and `3.3 V` rails.
3. Confirm external clock.
4. Release reset.
5. Read ROM ID over debug bus.
6. Toggle GPIO LEDs.
7. Run NPU add smoke command.
8. Observe IRQ outputs.
