# Nebius Resource Cleanup

Generated: `2026-05-24T03:45:59Z`

Cleaned obsolete run resources from `robot-full-1779504720` before launching
the new clean run.

| resource | id | action | result |
|---|---|---|---|
| instance | `computeinstance-e00x4sqmx07qwehxrc` | delete | ok |
| disk | `computedisk-e00te9qnayns1bsz15` | delete | ok |

Post-cleanup Nebius inventory showed no remaining compute instances or disks
before the new clean launch.

Current active clean run resources:

| resource | id |
|---|---|
| instance | `computeinstance-e00vp47p03jxxtqev3` |
| disk | `computedisk-e00bef82gpgk1qgx5y` |
| public IP | `89.169.120.252` |
