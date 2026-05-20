# E1 Phone EVT0 Mechanical CAD Review

Status: automated EVT0 concept generation, not tooling release.

## Generated Artifacts

- `mechanical/e1-phone/out/e1-phone-assembly.glb`
- `mechanical/e1-phone/out/e1-phone-mold-tooling.glb`
- `mechanical/e1-phone/out/*.obj` and `*.stl` per component
- `mechanical/e1-phone/review/manufacturing_drawing.png`
- `mechanical/e1-phone/review/manufacturing_drawing.svg`
- `mechanical/e1-phone/review/manufacturing_drawing.json`
- `mechanical/e1-phone/review/manufacturing-readiness.json`
- `mechanical/e1-phone/review/manufacturing-readiness.md`
- `mechanical/e1-phone/review/mass-budget.json`
- `mechanical/e1-phone/review/mass-budget.md`
- `mechanical/e1-phone/review/supplier-lock.json`
- `mechanical/e1-phone/review/supplier-lock.md`
- `mechanical/e1-phone/review/kicad-mechanical-handoff.json`
- `mechanical/e1-phone/review/kicad-mechanical-handoff.md`
- `mechanical/e1-phone/review/full_front_iso.png`
- `mechanical/e1-phone/review/full_back_iso.png`
- `mechanical/e1-phone/review/full_left_side.png`
- `mechanical/e1-phone/review/full_bottom_port.png`
- `mechanical/e1-phone/review/full_top_down.png`
- `mechanical/e1-phone/review/exploded_iso.png`
- `mechanical/e1-phone/review/component_stack.png`
- `mechanical/e1-phone/review/mold_tooling.png`
- `mechanical/e1-phone/review/visual-review.json`
- `mechanical/e1-phone/review/fit-check-report.json`

## Fit Checks

- PASS: `component_presence`
- PASS: `pcb_edge_clearance`
- PASS: `screen_mount_margin`
- PASS: `rounded_enclosure_geometry`
- PASS: `mesh_integrity`
- PASS: `usb_c_insertion_envelope`
- PASS: `bottom_io_acoustic_apertures`
- PASS: `button_force_and_travel`
- PASS: `button_pressure_support`
- PASS: `screen_mount_and_connection`
- PASS: `camera_speaker_behind_glass`
- PASS: `pcb_battery_non_overlap`
- PASS: `injection_molding_basics`
- PASS: `molded_retention_features`
- PASS: `mold_runner_gate_model`
- PASS: `final_assembly_excludes_tooling_markers`
- PASS: `kicad_outline_integration`
- PASS: `device_compactness`
- PASS: `mass_budget`

## Manufacturing Notes

- Plastic: PC+ABS or glass-filled PC/ABS, molded orange.
- Nominal draft: 2.0 degrees.
- Gate strategy: two submarine gates into back cover long edge, fan gate alternate for color consistency.
- Parting line: mid-plane around orange back shell perimeter.
- Sprue diameter: 4.0 mm.
- Runner diameter: 2.2 mm.
- Gate thickness: 0.85 mm.
- Estimated CAD mass: 127.51 g.

## Design Decisions From This Pass

- The envelope is widened to 78.0 mm because the selected commodity touch panel is 77.1 mm wide; a 72 mm device envelope contradicts that supplier outline unless the display anchor changes.
- Front camera and earpiece are kept behind the cover glass where practical. The rear camera stays exposed through a back lens window because the available AF module stack is too tall for full under-glass placement in a 9.6 mm phone.
- Orange hard plastic is modeled as the entire molded shell and button material. The black glass remains a separate bonded part.
- The enclosure now includes six screw bosses, eight snap hooks, battery ribs, a USB-C insertion saddle, display adhesive, display FPC connector keepout, and explicit cold-runner/submarine-gate placeholders for mold review.
- The exterior shell and cover glass now use rounded-rectangle geometry tied to the 7.5 mm corner-radius parameter instead of square block placeholders.
