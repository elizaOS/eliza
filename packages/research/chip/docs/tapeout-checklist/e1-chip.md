# E1 chip tapeout-readiness checklist

The e1 chip is ready as a pipeline milestone when:

- `pd/signoff/manifest.yaml` records no blocked gates for PD release, tapeout release, or board fabrication release.
- RTL syntax/elaboration passes.
- cocotb register tests pass.
- Verilator smoke test passes.
- DMA and NPU formal checks pass.
- Yosys synthesis emits a netlist and area report.
- OpenLane or OpenROAD either completes or has a documented tool/PDK blocker.
- PD signoff archives final GDS/DEF/netlist/SDC and clean or waived DRC, LVS, antenna, and STA reports.
- SI/PI evidence is archived for package models, board-level signal integrity, and power integrity.
- PDN/current budget evidence is archived for post-route power, IR-drop/EM, decoupling, and board current limits.
- Padframe/package evidence is archived for released IO cells, ESD/corner cells, package drawing, bond diagram, and board footprint.
- `docs/manufacturing/real-world-verification-gaps.yaml` has no remaining release-blocking physical, package, SI/PI, PDN/current-budget, board-fabrication, or first-article gaps.
- Memory map and interrupt map match the tests.
- All generated reports are stored under `build/` or `pd/reports/`.
