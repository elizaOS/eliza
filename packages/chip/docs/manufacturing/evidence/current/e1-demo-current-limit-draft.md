# E1 Demo First-Article Current-Limit Draft

Status: draft local bring-up plan, not first-article evidence
Board revision: `r0-nonrelease`
Review date: 2026-05-18
Reviewer: local board bring-up preflight
Disposition: blocked for fabrication release

## Scope

This document defines local current-limit starting points and stop conditions
for first power application. It is not a measured current log and does not
release the board for fabrication or bring-up.

## Initial Bench Limits

| Rail | Initial current limit | Initial voltage | Enable condition |
| --- | ---: | ---: | --- |
| 1.8 V core/planning rail | 25 mA | 1.8 V | Enable first with SoC held in reset |
| 3.3 V IO/planning rail | 25 mA | 3.3 V | Enable after 1.8 V rail is stable |

The 25 mA starting point is a conservative lab limit, not an expected operating
current. It is tied to the local OpenLane-only VDDCORE estimate in
`pd/signoff/pdn-current/local-budget.yaml` and must be replaced before hardware
execution by a board-revision-specific procedure. After shorts and static
current are reviewed, limits may be raised only by an approved first-article
procedure tied to the final board revision, regulator behavior, fuse limits,
package load model, and thermal stop conditions.

## Stop Conditions

- Any rail reaches current limit before the target voltage is within 5 percent.
- Any rail draws more than 2x the expected static current after reset is held.
- Rail monotonicity, sequencing, or reset behavior differs from the approved
  bring-up procedure.
- SoC package, PMIC, oscillator, regulator, or passives show abnormal heating.
- Clock, reset, or debug link is absent after rails are stable.

## Release Blockers

- No measured first-article current log is archived.
- No final rail current budget exists for the selected padframe/package.
- No thermal limit or package power model is approved.
- No regulator current-limit tolerance or foldback behavior is signed off.
- No sustained power/thermal capture manifest has passed
  `benchmarks/power/scripts/check_sustained_run_evidence.py`.
- No bring-up owner has accepted these limits for hardware execution.

## Required Release Evidence

- Final rail current budget with expected static, reset, debug-active, and NPU
  smoke-test currents.
- Lab current log for each rail, including supply model, limit settings,
  voltage ramp, ambient temperature, and board serial number.
- Sustained power/thermal manifest with calibrated power, thermal, frequency,
  workload transcript, and calibration artifacts.
- Explicit stop-condition review and first-article disposition.
- Updated limit table replacing this draft before any hardware power-on.
