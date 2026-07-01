# OpenLane Run Diagnosis: RUN_2026-05-19_01-52-14

- generated_at: 2026-05-19T02:47:55.787016+00:00
- run_dir: `pd/openlane/runs/RUN_2026-05-19_01-52-14`
- status: blocked
- blocker_step: `43-openroad-repairantennas`
- blocker: step directory exists without `state_out.json`
- last_discovered_step: `43-openroad-repairantennas`
- last_step_mtime_age_seconds: 514
- last_completed_step: `42-odb-heuristicdiodeinsertion`

## Blocking Step Evidence
- `state_in.json`: 8221 bytes
- `state_out.json`: missing
- `runtime.txt`: missing
- `COMMANDS`: missing
- `config.json`: 8364 bytes

## KLayout DRC Status
- status: not_started
- interpretation: KLayout DRC has not reached this run yet.

## Release Status
- Do not use this run as tapeout/signoff evidence until `final/` exists and release checks pass.
