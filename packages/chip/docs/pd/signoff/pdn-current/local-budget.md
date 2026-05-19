# PDN and current-budget local evidence

Status: `draft_local_evidence`
Release use: `prohibited_until_external_review`

This budget is derived from local OpenLane artifacts only. It is useful for
triage and first-article planning, but it is not a tapeout or board-fabrication
release approval.

## Selected local run

`pd/openlane/runs/RUN_2026-05-18_05-41-42`

Key local artifacts:

- `final/metrics.json`
- `final/metrics.csv`
- `57-openroad-irdropreport/irdrop.rpt`
- `20-openroad-generatepdn/openroad-generatepdn.log`
- `signoff-run.yaml`
- `benchmarks/power/local-estimates/e1-npu-openlane-npu-estimates.json`

## Derived budget

| Rail | Board net | Voltage | Local current basis | Local budget |
| --- | --- | ---: | ---: | ---: |
| VDDCORE | `+1V8` | 1.8 V | 5.554 mW / 1.8 V = 3.086 mA | 6.172 mA with 2x local margin |
| VDDIO | `+3V3` | 3.3 V | unavailable | blocked pending IO/package/board load model |

For first-article planning only, both rails should start with a 25 mA bench
current limit until workload-calibrated power and board loads replace this
local estimate.

The local estimate artifact also records the NPU architecture-model result
(`47.663` to `49.152` modeled INT8 TOPS) and the invalid arithmetic that would
result from dividing it by OpenLane power (`8581.556` to `8849.730` TOPS/W).
That arithmetic is kept only as a blocker tripwire: the power and TOPS values
come from different substrates and cannot support sustained efficiency claims.

## Local PDN observations

- OpenROAD reported all shapes connected on `VPWR` and `VGND`.
- `VPWR` worst local IR drop is 87.6137 uV at `nom_tt_025C_1v80`.
- `VGND` worst local bounce is 105.98 uV at `nom_tt_025C_1v80`.
- Metrics report zero power-grid violations for `VPWR` and `VGND`.

## Release blockers

- Replace local metrics-derived power with vector/workload-calibrated post-route
  power across selected release corners.
- Capture a measured sustained power/thermal run where TOPS, rail power,
  frequency, temperature, and throttle state share the same window.
- Archive EM evidence and any foundry-required current density checks.
- Derive VDDIO current from released IO pads, package model, and board loads.
- Archive board regulator, fuse, thermal, and first-article current-limit review.
- Tie this budget into released package, padframe, board, and thermal evidence.
