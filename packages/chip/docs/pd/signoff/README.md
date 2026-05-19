# Physical design signoff — e1 chip

This document covers the full OpenLane 2 PD flow for `e1_chip_top` on SKY130A,
the prerequisite environment, how to launch a run, what outputs to expect, and the
pass criteria for each signoff check.

- Routed GDS/OASIS.
- Final DEF.
- Gate-level netlist.
- Liberty/corner list.
- SDC.
- SPEF/SDF when available.
- DRC report.
- LVS report.
- Antenna report.
- STA WNS/TNS per corner.
- Utilization/congestion report.
- Density/fill report.
- Waiver file for every non-clean check.
- Per-run `signoff-run.yaml` matching `pd/signoff/run-manifest.schema.json`, recording the exact flow, PDK, image digest, corners, inputs, outputs, and clean or waived report status.
- SI/PI evidence for package models, board-level signal integrity, and power integrity.
- PDN/current-budget evidence for post-route power, IR-drop/EM, decoupling, and board current limits.
- Thermal evidence for package/board temperature limits, regulator loss, ambient/enclosure assumptions, and first-article stop conditions.
- Padframe/package evidence for foundry IO/ESD/corner cells, package drawing, bond diagram, and footprint release.

The current `e1_soc_top` can be hardened as a padless macro. A standalone fabricated chip also requires the padframe plan in `docs/pd/padframe/e1_demo_padframe.md`.

The machine-readable artifact gate is `pd/signoff/manifest.yaml`. The per-run manifest schema is `pd/signoff/run-manifest.schema.json`; it is intentionally separate from the repository-level manifest so a selected OpenLane/OpenROAD run can be archived without editing release policy.

Local-only SI/PI and PDN/current triage evidence lives in
`pd/signoff/si-pi/local-evidence.yaml`,
`docs/pd/signoff/si-pi/local-gap-report.md`,
`pd/signoff/pdn-current/local-budget.yaml`, and
`docs/pd/signoff/pdn-current/local-budget.md`. These files document what can be
produced from local OpenLane and board-planning artifacts; they intentionally
keep tapeout and board-fabrication gates blocked until package models, board
stackup, SI/PI reviews, EM reports, VDDIO load data, and first-article current
limits are externally closed.

Run:

```sh
make pd-signoff-manifest-check   # fast structural check (no tool output needed)
make pd-signoff-check            # hard release gate
```

The manifest check validates required artifact classes, run-scoped globs, explicit blocked gates, and the SI/PI, PDN/current-budget, padframe/package, and thermal readiness sections without requiring tool output, so it is safe for fast product checks. The full signoff check is a hard release gate: one OpenLane/OpenROAD run directory must contain nonempty final GDS, DEF, gate netlist, corner manifest, SDC, SPEF, SDF, DRC, LVS, antenna, STA, utilization, congestion, density/fill, run-manifest, and tool-version artifacts. Signoff reports must include clean markers while avoiding failure patterns, and release gates must no longer be blocked.
