# E1 demo KiCad command capture plan

The checked-in KiCad project is a local planning scaffold only. These commands
are the required headless transcript plan for regenerating ERC, DRC, fabrication,
BOM, position, drawing, and provenance outputs once the package/vendor footprint
and board review inputs are real.

The commands must be run from the repository root and captured in
`board/reports/fab/<rev>/kicad-command-transcript.txt` with matching
`board/reports/fab/<rev>/kicad-tool-versions.txt`. Existing scaffold outputs do
not unblock board fabrication release until the package, footprint, SI/PI,
current-limit, DFM, and first-article evidence is archived and reviewed.

```sh
kicad-cli version
kicad-cli sch erc --output board/reports/fab/<rev>/e1-demo-erc-report.txt board/kicad/e1-demo/e1-demo.kicad_sch
kicad-cli pcb drc --output board/reports/fab/<rev>/e1-demo-drc-report.txt board/kicad/e1-demo/e1-demo.kicad_pcb
kicad-cli pcb export gerbers --output board/reports/fab/<rev>/gerbers board/kicad/e1-demo/e1-demo.kicad_pcb
kicad-cli pcb export drill --output board/reports/fab/<rev>/drill board/kicad/e1-demo/e1-demo.kicad_pcb
kicad-cli sch export bom --output board/reports/fab/<rev>/e1-demo-bom.csv board/kicad/e1-demo/e1-demo.kicad_sch
kicad-cli pcb export pos --output board/reports/fab/<rev>/e1-demo-position.csv board/kicad/e1-demo/e1-demo.kicad_pcb
kicad-cli pcb export pdf --output board/reports/fab/<rev>/pdf/e1-demo-fab-drawing.pdf board/kicad/e1-demo/e1-demo.kicad_pcb
python3 scripts/check_manufacturing_artifacts.py --resolved-manifest build/reports/manufacturing-resolved-artifacts.json
python3 scripts/run_product_evidence_command.py --list
```

Release capture must also include:

- Package vendor drawing checksum or immutable revision.
- KiCad symbol and footprint source review.
- Cross-probe report for package pins, KiCad pins, footprint pads, and board nets.
- Stackup, SI/PI, PDN/current-budget, and DFM evidence referenced by
  `docs/manufacturing/release-manifest.yaml`.
