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

## Current upstream binary issue

On 2026-05-19, both documented Google Cloud Storage binary paths tested from
this workstation returned 298-byte `AccessDenied` XML responses rather than
artifacts:

- `placement_cost/plc_wrapper_main_0.0.4`
- `dreamplace/dreamplace_20231214_c5a83e5_python3.9.tar.gz`

The local wrapper works around the first issue by using the Linux
`plc_wrapper_main` binary vendored in Farama's public
`a2perf-circuit-training` repository:

https://github.com/Farama-Foundation/a2perf-circuit-training

The second issue requires either:

```sh
scripts/alphachip/build_dreamplace_from_source.sh
scripts/alphachip/build_container.sh
```

or obtaining a compatible DREAMPlace tarball and passing:

```sh
DREAMPLACE_TARBALL=/path/to/dreamplace_..._python3.9.tar.gz scripts/alphachip/build_container.sh
```

## Compute note

The upstream Ariane-scale recipe used one 8x V100 training host, one 32 vCPU
Reverb/eval host, and around 500 collect jobs across 20 CPU hosts. Fewer collect
jobs should still work but increases walltime. Local 16 GB VRAM can run smoke
tests and likely small E1 experiments; full pretraining should use H200-class
cloud hardware if walltime or memory becomes limiting.
