# Nebius Training Relaunch Plan

Relaunch ready: `True`
Recommendation: `ready_to_launch_clean_run`
Generated: `2026-05-23T17:03:00.000823Z`
Current run: `robot-full-1779504720`
Current instance: `computeinstance-e00x4sqmx07qwehxrc`

## Active Run

- closeout_state: `running`
- closeout_ok: `False`
- stale: `True`
- hard_cap_exceeded: `True`
- elapsed_hours: `14.0822`
- hours_until_hard_cap: `-2.0822`
- cleanup_allowed: `False`

## Blockers

- none

## Next Actions

- Stop or replace hard-cap-exceeded active instance computeinstance-e00x4sqmx07qwehxrc before creating the clean run.
- Package and upload repo payload with /home/shaw/milady/eliza/packages/robot/evidence/full_training_preflight/nebius_instance_launch_template.json.
- Inject object-storage credentials outside VM metadata on the host.
- Create a new Nebius H200 instance from the validated template.
