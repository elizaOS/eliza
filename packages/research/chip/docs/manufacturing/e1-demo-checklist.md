# E1 demo manufacturing checklist

This checklist is for the simple demo chip/board product slice.

The machine-readable inventory of release-blocking physical, package, SI/PI,
PDN/current-budget, board-fabrication, and first-article gaps is
`docs/manufacturing/real-world-verification-gaps.yaml`. Run
`make physical-closure-work-order-check` and `make real-world-gates-check`
before any PD, tapeout, or board-fabrication release claim.

The detailed physical/product work order is
`docs/manufacturing/physical-closure-work-order.yaml`. It is an acceptance
manifest, not evidence. Do not treat any vendor, foundry, board-house,
assembly-house, SI/PI, PDN, or lab item as complete until its named artifact is
archived and the corresponding gate is intentionally unblocked.

## Tapeout package

- Release status: blocked until `pd/signoff/manifest.yaml` has no blocked gates.
- Final RTL commit recorded.
- Tool versions recorded.
- PDK version recorded.
- GDS/OASIS archived.
- DEF archived.
- Gate netlist archived.
- SPEF/SDF archived when available.
- SDC archived.
- DRC clean or waivers approved.
- LVS clean or waivers approved.
- Antenna clean or waivers approved.
- STA clean across selected corners or waivers approved.
- Pinout and bonding diagram approved.
- Padframe/power strategy approved.
- SI/PI artifacts archived: package model, board SI report, and power-integrity report.
- PDN/current budget archived for `VDDCORE` and `VDDIO`, including post-route power, IR-drop/EM, decoupling, and board current limits.
- Local-only SI/PI gap evidence is archived in
  `pd/signoff/si-pi/local-evidence.yaml` and
  `docs/pd/signoff/si-pi/local-gap-report.md`; it is not release evidence until
  package, board-stackup, SI, and PI reviews are externally closed.
- Local-only PDN/current evidence is archived in
  `pd/signoff/pdn-current/local-budget.yaml` and
  `docs/pd/signoff/pdn-current/local-budget.md`; it is not release evidence until
  vector-calibrated power, EM, VDDIO load, regulator, and first-article reviews
  are externally closed.
- Every gap in `docs/manufacturing/real-world-verification-gaps.yaml` is closed by archived evidence and the linked release gate is unblocked.

## Board package

- Fabrication status: blocked until package, footprint, SI/PI, PDN, and DFM evidence are archived.
- Package drawing approved.
- Symbol/footprint reviewed.
- Power rails and current limits reviewed.
- Oscillator/reset reviewed.
- Debug connector reviewed.
- LED/IRQ test points reviewed.
- Assembly notes complete.
- First-article smoke test plan complete.
