# Baseline AlphaChip Experiments

## Experiment 0: environment smoke

Purpose: prove Docker, TF-Agents/Reverb, DREAMPlace, and placement-cost binary
work locally.

```sh
scripts/alphachip/build_container.sh
scripts/alphachip/run_toy_training.sh
```

Expected output: logs and checkpoints in `build/alphachip/toy/run_00`.

## Experiment 1: upstream Ariane smoke

Purpose: validate the canonical RISC-V example before touching E1.

```sh
ALPHACHIP_RUN_DIR=build/alphachip/ariane_smoke scripts/alphachip/run_smoke.sh
```

This is CPU-capable but can take tens of minutes. Use GPU only after the CPU
smoke succeeds.

## Experiment 2: TILOS public macro-placement corpus

Purpose: run known public macro-heavy cases through the same conversion and
validation path we will use for E1.

Inputs:

- TILOS converted protobuf/PLC if available.
- TILOS LEF/DEF cases for converter validation.
- OpenROAD/OpenLane flow tarballs for post-placement validation.

Output:

- Candidate placements.
- OpenROAD/OpenLane validation metrics.
- Conversion notes and failure cases.

## Experiment 3: E1 first candidate

Purpose: generate one E1 macro-placement candidate and round-trip through
OpenLane.

Blocking requirement: E1 hard macro inventory and LEF/DEF handoff exists.

Acceptance:

- Candidate DEF imports into OpenROAD.
- OpenLane completes placement/routing.
- Physical signoff gates produce actionable pass/fail evidence.
