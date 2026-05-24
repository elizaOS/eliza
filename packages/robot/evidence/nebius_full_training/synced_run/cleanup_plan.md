# Nebius Training Cleanup Plan

Cleanup allowed: `False`
Complete: `False`
Override used: `False`
Closeout state: `running`
Closeout ok: `False`
Finalization ok: `False`
Artifact inventory ok: `False`
Validation ok: `False`
Training report ok: `False`

## Blockers

- closeout_status.ok is not true
- finalization_report.ok is not true
- artifact_inventory.ok is not true
- validation_report.ok is not true
- training_comparison_report.ok is not true

## Commands

Cleanup commands are held until closeout is complete:
- `nebius compute instance stop computeinstance-e00x4sqmx07qwehxrc`
- `nebius compute instance delete computeinstance-e00x4sqmx07qwehxrc`
- `nebius compute disk delete computedisk-e00te9qnayns1bsz15`
