# Google Circuit Training / AlphaChip

Source: https://github.com/google-research/circuit_training

License: Apache-2.0.

Local checkout: `external/circuit_training`, pinned to `r0.0.4`
(`c5a83e567a8b7669c573d508c555aa0dfd2a76a5` at setup time).

## What it provides

- Distributed PPO macro-placement trainer.
- TensorFlow / TF-Agents based learner, collect, eval, and Reverb jobs.
- DREAMPlace integration for standard-cell placement inside proxy evaluation.
- Netlist protobuf format based on TensorFlow `MetaGraphDef`.
- Example Ariane RISC-V and toy netlists.
- Public TPU pre-trained checkpoint, with a recommendation to pretrain on
  in-domain chip blocks for best results.

## Installation notes

Upstream supports Linux and Python 3.9+. The recommended path is Docker. Stable
`r0.0.4` uses:

- Python: `python3.9`
- TF-Agents: `tf-agents[reverb]~=0.19.0`
- DREAMPlace binary:
  `dreamplace_20231214_c5a83e5_python3.9.tar.gz`
- Placement-cost binary: `plc_wrapper_main_0.0.4`

Local wrapper:

```sh
scripts/alphachip/build_container.sh
scripts/alphachip/run_toy_training.sh
```

## Current upstream binary status (2026-05-21)

The documented Google Cloud Storage binary paths still return HTTP 403
`AccessDenied` (verified by `check_alphachip_checkpoint_blocker.py --network`):

- `placement_cost/plc_wrapper_main` / `_0.0.4`
- `dreamplace/dreamplace_20231214_c5a83e5_python3.9.tar.gz`
- `tpu_checkpoint_20240815.tar.gz`

A lawful mirror of the **binary** (not the checkpoint) is available from the
Apache-2.0 Farama repository, verified live on 2026-05-21:

https://github.com/Farama-Foundation/a2perf-circuit-training

It serves `bin/plc_wrapper_main` (10,605,424 bytes, a genuine Linux x86-64 ELF,
sha256 `86fe9a2841fc21d3c18bb838d93fff128ceb51f82490d561e22985caab00c9b3`) plus a
`dreamplace_builds/` directory. `scripts/alphachip/build_container.sh` already
points at this URL via `PLC_BINARY_URL`. Downloaded locally it executes and
computes the documented proxy terms on the Ariane fixtures.

The DREAMPlace standard-cell placer (needed for the full RL collect loop, not for
proxy-cost evaluation) can come from the Farama `dreamplace_builds/`, from
`scripts/alphachip/build_dreamplace_from_source.sh`, or from a compatible tarball
passed as `DREAMPLACE_TARBALL=... scripts/alphachip/build_container.sh`.

For proxy-cost evaluation that needs neither the binary nor DREAMPlace, use the
open BSD-3 path: `scripts/alphachip/open_proxy_cost.py` (TILOS `plc_client_os`).
See `docs/toolchain/alphachip-checkpoint-blocker.md` for the full status and the
two irreducible blockers (the TPU checkpoint mirror, and full distributed PPO on
CPU).

## Compute note

The upstream Ariane-scale recipe used one 8x V100 training host, one 32 vCPU
Reverb/eval host, and around 500 collect jobs across 20 CPU hosts. Fewer collect
jobs should still work but increases walltime. Local 16 GB VRAM can run smoke
tests and likely small E1 experiments; full pretraining should use H200-class
cloud hardware if walltime or memory becomes limiting.
