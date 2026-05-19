# Nebius H200 AlphaChip Runbook

Use this when local 16 GB VRAM is too small or too slow. AlphaChip's published
Ariane-scale recipe used 8x V100 for training plus many CPU collect workers; a
single H200 should be enough for first E1 experiments, but walltime will still
depend on how many CPU collect jobs feed Reverb.

## Machine shape

- 1 GPU training host: H200, Docker, NVIDIA container runtime, 200 GB disk.
- 1 CPU/Reverb host: 32+ vCPU, 100 GB disk.
- Optional CPU collect pool: start with 32-96 vCPU total; scale collect jobs
  until the learner is no longer waiting for replay data.
- Shared storage: mounted filesystem or object storage for `ROOT_DIR`.

## Setup

```sh
git clone <this-repo> e1-chip
cd e1-chip/packages/chip
git clone https://github.com/google-research/circuit_training.git external/circuit_training
git -C external/circuit_training checkout r0.0.4
scripts/alphachip/build_container.sh
```

For a GPU image:

```sh
ALPHACHIP_GPU_IMAGE=1 scripts/alphachip/build_container.sh
```

## First cloud smoke

```sh
USE_GPU=True NUM_COLLECT_JOBS=8 scripts/alphachip/run_toy_training.sh
```

## E1 training shape

Once `NETLIST_FILE` and `INIT_PLACEMENT` point to converted E1 protobuf/PLC
artifacts:

```sh
export ROOT_DIR=/shared/alphachip/e1/run_001
export REVERB_SERVER=<reverb-host-ip>:8008
export NETLIST_FILE=/shared/alphachip/e1/netlist.pb.txt
export INIT_PLACEMENT=/shared/alphachip/e1/initial.plc
```

Run `ppo_reverb_server` on the Reverb host, many `ppo_collect` jobs on CPU
hosts, and `train_ppo --use_gpu` on the H200 host. Match the upstream
`docs/ARIANE.md` job split and tune `sequence_length` to the number of movable
E1 macros or soft macros.
