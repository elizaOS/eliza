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

The lighter current path is to build the normal AlphaChip image and add the
CUDA 12.2 user-space wheels expected by TensorFlow 2.15:

```sh
scripts/alphachip/build_container.sh
ALPHACHIP_IMAGE=circuit_training:e1-r0.0.4-cuda-pip \
  scripts/alphachip/build_cuda_runtime_image.sh
```

If Docker's NVIDIA runtime is unavailable but the GPU devices are visible, the
local wrappers can use direct device mounts:

```sh
ALPHACHIP_GPU_MODE=manual USE_GPU=True scripts/alphachip/run_toy_training.sh
```

## First cloud smoke

```sh
USE_GPU=True NUM_COLLECT_JOBS=8 scripts/alphachip/run_toy_training.sh
```

## E1 training shape

Prepare the E1 soft-macro benchmark from an OpenLane DEF:

```sh
ALPHACHIP_BENCH_DIR=/shared/alphachip/e1_softmacro_full \
  scripts/alphachip/prepare_e1_softmacro_benchmark.sh \
    --def pd/openlane/runs/<run>/46-openroad-detailedrouting/e1_chip_top.def \
    --cols 16 \
    --rows 16
```

Measure the OpenROAD-derived baseline:

```sh
ALPHACHIP_COMPARE_DIR=/shared/alphachip/e1_softmacro_full/compare \
  scripts/alphachip/compare_proxy_costs.sh /shared/alphachip/e1_softmacro_full
```

Run a first integrated GPU experiment:

```sh
ALPHACHIP_BENCH_DIR=/shared/alphachip/e1_softmacro_full \
ALPHACHIP_RUN_DIR=/shared/alphachip/e1_softmacro_full_train \
USE_GPU=True \
NUM_COLLECT_JOBS=8 \
SEQUENCE_LENGTH=257 \
OBS_MAX_NUM_NODES=512 \
OBS_MAX_NUM_EDGES=8192 \
OBS_MAX_GRID_SIZE=16 \
TRAIN_ITERATIONS=5 \
EPISODES_PER_ITERATION=16 \
PER_REPLICA_BATCH_SIZE=16 \
  scripts/alphachip/run_e1_softmacro_training.sh
```

The integrated runner starts Reverb, CPU collectors, the learner, and the
upstream evaluator. The evaluator writes:

```text
<ALPHACHIP_RUN_DIR>/run_00/eval_output/rl_opt_placement.plc
```

Compare the exported placement:

```sh
ALPHACHIP_PLC=/shared/alphachip/e1_softmacro_full_train/run_00/eval_output/rl_opt_placement.plc \
ALPHACHIP_COMPARE_DIR=/shared/alphachip/e1_softmacro_full/compare \
  scripts/alphachip/compare_proxy_costs.sh /shared/alphachip/e1_softmacro_full
```

## Payload from this workstation

The current full E1 benchmark can be packaged for upload:

```sh
scripts/alphachip/package_nebius_payload.sh /tmp/e1-alphachip/e1_softmacro_full
```

This writes:

```text
build/alphachip/nebius/e1_alphachip_payload.tar.gz
```

After extracting that archive on an H200 host, the remote one-command runner is:

```sh
NUM_COLLECT_JOBS=8 \
TRAIN_ITERATIONS=5 \
EPISODES_PER_ITERATION=16 \
PER_REPLICA_BATCH_SIZE=16 \
  scripts/alphachip/run_h200_payload.sh
```

`run_h200_payload.sh` builds `circuit_training:e1-r0.0.4` first, then derives
`circuit_training:e1-r0.0.4-cuda-pip`, runs the OpenROAD proxy baseline, trains,
and re-runs the comparison against the evaluator-exported AlphaChip PLC.

The Nebius CLI is configured in this workspace, but federation auth may need to
be refreshed before VM commands work:

```sh
nebius profile list
nebius compute instance list --parent-id project-e00kfz6cpr00q21z892vec
```

## Fully autonomous run (private-IP H200, self-shutdown)

Public-IP quota is exhausted, so the box runs with a private IP only and returns
results via a Nebius S3 bucket. The full lifecycle is scripted:

```sh
# 1. Prepare benchmark from the routed SoC DEF (pass the SRAM macro LEF).
ALPHACHIP_BENCH_DIR=/tmp/e1-alphachip/e1_softmacro_full \
  scripts/alphachip/prepare_e1_softmacro_benchmark.sh \
    --def <routed.def> --cols 16 --rows 16 \
    --lef external/pdks/volare/sky130/versions/<ver>/sky130A/libs.ref/sky130_sram_macros/lef/sky130_sram_2kbyte_1rw1r_32x512_8.lef

# 2. Package the self-contained payload (CT source + lawful plc + benchmark).
ALPHACHIP_BENCH_DIR=/tmp/e1-alphachip/e1_softmacro_full \
  scripts/alphachip/package_nebius_autonomous_payload.sh

# 3. Credentials in /tmp/nebius_ppo_creds.env (bucket, access key, endpoint).
#    Launch: uploads payload, generates cloud-init, creates disk + private-IP VM.
ALPHACHIP_PAYLOAD_TAR=$PWD/build/alphachip/nebius/e1_ppo_autonomous_payload.tar.gz \
  scripts/alphachip/launch_nebius_ppo.sh   # records id to /tmp/nebius_ppo_instance_id

# 4. Poll for results (DONE marker + tarball), then validate.
scripts/alphachip/fetch_nebius_ppo_results.sh

# 5. Delete instance + boot disk + access key + bucket; verify NotFound.
scripts/alphachip/teardown_nebius_ppo.sh
```

The cloud-init bakes in TWO self-destruct backstops: `shutdown -h +600` at boot
(10h hard cap) and an explicit `poweroff` at the end of the on-box job script.
The on-box job (`run_autonomous_h200_job.sh`) builds the CUDA image, runs the
OpenROAD proxy baseline, trains PPO from random init (no pretrained checkpoint),
re-runs the comparison, uploads the result tarball, and powers off.

For larger runs, either keep the integrated runner or split jobs manually:
`ppo_reverb_server` on the Reverb host, many `ppo_collect` jobs on CPU hosts,
`train_ppo --use_gpu` on the H200 host, and `learning.eval` pointed at the same
variable-container server. Match the upstream `docs/ARIANE.md` job split and
tune `sequence_length` to the number of movable E1 soft macros.
