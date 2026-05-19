# SI/PI local evidence and remaining release blockers

Status: `draft_local_evidence`
Release use: `prohibited_until_external_review`

This report records what can be proven from local repository artifacts as of
2026-05-18. It does not claim vendor, board-house, package-vendor, or foundry
approval.

## Local evidence inputs

- `package/e1-demo-pinout.yaml`: placeholder package pinout.
- `docs/board/kicad/e1-demo/fab-notes.md`: KiCad planning notes that mark
  the board package as non-release demo planning evidence.
- `pd/openlane/runs/RUN_2026-05-18_05-41-42/signoff-run.yaml`: selected local
  OpenLane run record.
- `pd/openlane/runs/RUN_2026-05-18_05-41-42/final/metrics.json`: routed digital
  metrics for local context.

## Findings

The local tree has enough information to define SI/PI work items, but not enough
to close SI/PI release. Package electrical models, released board stackup,
impedance targets, and board-level simulation outputs are absent.

Clock, reset, debug, GPIO, IRQ, and JTAG nets therefore remain unsimulated at the
board/package boundary. Power integrity also remains open because the repository
does not contain rail impedance targets, decoupling impedance analysis,
return-path review, or first-article measurements.

## Release blockers

- Archive a package model: IBIS, SPICE, S-parameter, or extracted parasitics.
- Release board stackup and impedance rules.
- Run or review board SI for clock, reset, debug, GPIO, IRQ, and JTAG nets.
- Archive PI impedance, decoupling, return-current, and plane-continuity review.
- Cross-reference the released package model and board stackup from
  `pd/signoff/manifest.yaml`.
