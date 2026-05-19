# E1 demo KiCad planning notes

Evidence class: `non_release_demo_planning`
Release use: `prohibited`

`board/kicad/e1-demo` now contains a minimal KiCad project, schematic, PCB,
and planning footprint so the package pinout can be cross-probed and the board
can be opened or printed for review. These sources are planning artifacts only.
They are not board fabrication evidence and are not a substitute for a vendor
land pattern, release-reviewed ERC/DRC, Gerbers, drill output, BOM, placement
files, assembly package, or DFM review.

See `docs/manufacturing/physical-closure-work-order.yaml` for all acceptance criteria.

- KiCad project source: `board/kicad/e1-demo/e1-demo.kicad_pro`.
- Planning schematic source: `board/kicad/e1-demo/e1-demo.kicad_sch`.
- Planning PCB source: `board/kicad/e1-demo/e1-demo.kicad_pcb`.
- Planning footprint source:
  `board/kicad/e1-demo/e1_demo_planning.pretty/e1_demo_qfn64_planning.kicad_mod`.
- Dated KiCad CLI outputs under `board/reports/fab/e1-demo-2026-05-17/`
  are planning-review evidence only. They do not release the board for
  fabrication.
- Release still requires reviewed Gerber, drill, BOM, position, fab drawing,
  ERC, DRC, command transcript, and tool-version outputs with vendor/package
  provenance.
- `package/e1-demo-pinout.yaml` is a placeholder planning pinout and is not sufficient to generate fabrication-ready KiCad artifacts.
- Required command capture and artifact manifests are documented in
  `board/kicad/e1-demo/artifact-manifest.yaml`.

## Board Specification

- Package is placeholder-only.
- Footprint is not derived from a package vendor drawing.
- No package drawing checksum or immutable revision is recorded.
- No bond diagram has been released.
- Power sequencing and decoupling values are preliminary.
- No SI/PI analysis has been performed.
- No assembly house DFM review has been performed.
- No release-checked schematic, PCB, Gerbers, drill files, BOM, or placement
  files exist in this directory.
- Power sequencing and decoupling values are preliminary.
- No SI/PI analysis has been performed.
- No assembly house DFM review has been performed.

Bring-up intent:

1. Current-limit both rails.
2. Confirm `1.8 V` and `3.3 V` rails.
3. Confirm external clock.
4. Release reset.
5. Read ROM ID over debug bus.
6. Toggle GPIO LEDs.
7. Run NPU add smoke command.
8. Observe IRQ outputs.
