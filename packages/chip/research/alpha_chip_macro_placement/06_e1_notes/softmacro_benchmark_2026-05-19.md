# E1 AlphaChip Soft-Macro Benchmark - 2026-05-19

## Current benchmark path

The E1 RTL is currently a standard-cell-only OpenLane design from AlphaChip's
perspective, so the first runnable AlphaChip target groups placed standard
cells into soft macros. This gives AlphaChip a macro placement problem that can
be trained and compared against the OpenROAD/OpenLane placement.

Scripts added for this flow:

- `scripts/alphachip/prepare_e1_softmacro_benchmark.sh`
- `scripts/alphachip/make_soft_macro_benchmark.py`
- `scripts/alphachip/run_e1_softmacro_training.sh`
- `scripts/alphachip/evaluate_plc.py`
- `scripts/alphachip/compare_proxy_costs.sh`
- `scripts/alphachip/run_coordinate_descent.py`
- `scripts/alphachip/package_nebius_payload.sh`
- `scripts/alphachip/run_h200_payload.sh`

## Smoke benchmark

Source DEF:

- `pd/openlane/runs/RUN_2026-05-18_21-17-38/43-openroad-globalrouting/e1_pd_smoke_top.def`

Benchmark:

- `/tmp/e1-alphachip/e1_softmacro_smoke/e1_softmacro.pb.txt`
- `/tmp/e1-alphachip/e1_softmacro_smoke/e1_softmacro.openroad.plc`

Shape:

- Soft macros: 16
- Ports: 24
- Original standard cells: 2035

OpenROAD-derived proxy baseline:

```json
{
  "proxy_cost": 0.49857307008790586,
  "wirelength_cost": 0.161748724077143,
  "congestion_cost": 0.4735298602409835,
  "density_cost": 0.2001188317805422,
  "wirelength": 1469.898
}
```

First local CPU AlphaChip smoke placement:

```json
{
  "proxy_cost": 0.7614907575054299,
  "wirelength_cost": 0.3766429638824149,
  "congestion_cost": 0.5146988828810166,
  "density_cost": 0.2549967043650134,
  "wirelength": 3422.758
}
```

This did not beat the OpenROAD-derived smoke baseline. The run was stopped
because the learner was still CPU-bound after exporting an initial placement.

## Full E1 benchmark

Source DEF:

- `pd/openlane/runs/RUN_2026-05-19_05-08-54/46-openroad-detailedrouting/e1_chip_top.def`

Benchmark:

- `/tmp/e1-alphachip/e1_softmacro_full/e1_softmacro.pb.txt`
- `/tmp/e1-alphachip/e1_softmacro_full/e1_softmacro.openroad.plc`

Shape:

- Soft macros: 256
- Ports: 37
- Original standard cells: 131175
- Grouping: 16 x 16
- Area scale: 0.08

OpenROAD-derived proxy baseline:

```json
{
  "proxy_cost": 0.2379472967678485,
  "wirelength_cost": 0.1004376032488363,
  "congestion_cost": 0.2545012769251027,
  "density_cost": 0.02051811011292171,
  "wirelength": 787353.3540000028
}
```

Circuit Training coordinate-descent control placement:

Artifacts:

- `/tmp/e1-alphachip/e1_softmacro_full_cd/cd_k1_e1.plc`
- `/tmp/e1-alphachip/e1_softmacro_full_cd/cd_k1_e1.json`

Best observed proxy result:

```json
{
  "proxy_cost": 0.23079368872977124,
  "wirelength_cost": 0.1013436044848093,
  "congestion_cost": 0.2406078060591845,
  "density_cost": 0.01829236243073939,
  "wirelength": 794455.7049999984
}
```

This is a 3.01% proxy-cost improvement over the OpenROAD-derived full E1
soft-macro baseline, mostly from lower congestion and density penalty. Routed
wirelength is slightly higher than the OpenROAD-derived placement, so this is a
proxy-cost win, not yet a physical-signoff win.

The control run used Circuit Training's coordinate-descent placer, not the
AlphaChip PPO policy. It proves that the current benchmark can be optimized
against the CT/AlphaChip proxy cost locally, and gives the PPO run a stronger
target than the OpenROAD baseline.

## Training status

Local CPU training is now usable for coarse E1 soft-macro placement tests.
The full 256-soft-macro benchmark still needs GPU-scale training, but the
16-soft-macro current-chip benchmark produced a verified AlphaChip PPO
placement that beats the OpenROAD-derived placement under the CT proxy cost.

A wrapper bug that used a different default seed for Reverb than for training
was fixed by propagating `GLOBAL_SEED` to all CT processes. Full E1 training
also now passes the sequence length to collectors; the 256-soft-macro benchmark
uses `SEQUENCE_LENGTH=257` by default, matching 256 placement decisions plus
the boundary step.

The E1 wrapper now defaults to a smaller observation/model shape:

- `OBS_MAX_NUM_NODES=512`
- `OBS_MAX_NUM_EDGES=8192`
- `OBS_MAX_GRID_SIZE=16`

This is valid for the current E1 soft-macro benchmark. The benchmark reports
286 total nodes and 1871 sparse edges, with a 16 x 16 placement grid. The
original CT defaults target TPU-block scale (`3500` nodes, `42000` edges, and a
128 x 128 grid), which is unnecessarily large for the current E1 experiment.

A local full-E1 CPU probe using the reduced shape reached learner iteration 0,
but was stopped after the collector repeatedly hit infeasible random placements
before completing the 256-step horizon. This validates the E1 environment and
reduced model shape, but does not produce a scored AlphaChip placement.

## AlphaChip PPO win - 16 soft macros

Source DEF:

- `pd/openlane/runs/RUN_2026-05-19_05-08-54/46-openroad-detailedrouting/e1_chip_top.def`

Benchmark:

- `/tmp/e1-alphachip/e1_softmacro_4x4/e1_softmacro.pb.txt`
- `/tmp/e1-alphachip/e1_softmacro_4x4/e1_softmacro.openroad.plc`

Shape:

- Soft macros: 16
- Ports: 37
- Original standard cells: 131175
- Grouping: 4 x 4
- Placement grid reported by CT: 10 x 10

Training run:

```sh
ALPHACHIP_BENCH_DIR=/tmp/e1-alphachip/e1_softmacro_4x4 \
ALPHACHIP_RUN_DIR=/home/shaw/e1-alphachip-runs/e1_4x4_ppo_100it \
REVERB_PORT=8031 \
GLOBAL_SEED=601 \
NUM_COLLECT_JOBS=4 \
SEQUENCE_LENGTH=17 \
OBS_MAX_NUM_NODES=96 \
OBS_MAX_NUM_EDGES=2048 \
OBS_MAX_GRID_SIZE=16 \
TRAIN_ITERATIONS=100 \
EPISODES_PER_ITERATION=16 \
PER_REPLICA_BATCH_SIZE=8 \
RUN_EVAL=True \
  scripts/alphachip/run_e1_softmacro_training.sh
```

The run reached model id 100. The shell wrapper reported a trailing EOF message
after training finished, but the evaluator placement was written and scored
independently.

Independent comparison:

```sh
ALPHACHIP_PLC=/home/shaw/e1-alphachip-runs/e1_4x4_ppo_100it/run_00/eval_output/rl_opt_placement.plc \
ALPHACHIP_COMPARE_DIR=/tmp/e1-alphachip/e1_softmacro_4x4/compare_ppo_100it \
  scripts/alphachip/compare_proxy_costs.sh /tmp/e1-alphachip/e1_softmacro_4x4
```

OpenROAD-derived proxy baseline:

```json
{
  "proxy_cost": 0.30731151471270235,
  "wirelength_cost": 0.1662631983626067,
  "congestion_cost": 0.2201561798041126,
  "density_cost": 0.06194045289607875,
  "wirelength": 45185.10999999999
}
```

AlphaChip PPO proxy result:

```json
{
  "proxy_cost": 0.2737927680454493,
  "wirelength_cost": 0.1344793378601263,
  "congestion_cost": 0.2136948557043429,
  "density_cost": 0.064932004666303,
  "wirelength": 36547.25599999999
}
```

This is a 10.91% proxy-cost improvement over the OpenROAD-derived 16-soft-macro
E1 placement. The improvement comes from lower wirelength and congestion proxy
terms, with a slightly higher density proxy term.

This is not yet a full 256-soft-macro AlphaChip win and is not routed signoff
evidence. It is a verified local AlphaChip PPO placement win on a coarse
current-chip benchmark, proving the local training/compare loop works end to
end.

Local GPU status:

- `nvidia-smi` sees an RTX 5080 Laptop GPU with 16 GB VRAM.
- Docker's native `--gpus all` path fails because the NVIDIA runtime/CDI vendor
  is not registered.
- Direct manual device mounts can expose `nvidia-smi` inside a container.
- A derived image, `circuit_training:e1-r0.0.4-cuda-pip`, adds the CUDA 12.2
  user-space libraries needed by TensorFlow 2.15.
- Even with those libraries and a privileged/manual device mount, `cuInit`
  returns `CUDA_ERROR_NO_DEVICE` on this workstation. This points to the local
  Docker/device setup, not the AlphaChip Python environment.
- A Nebius H200 host with a working NVIDIA container runtime remains the
  practical path for the full 256-soft-macro training run.

The training wrapper now starts the upstream evaluator during training. The
evaluator writes:

- `<run_dir>/run_00/eval_output/rl_opt_placement.plc`

That placement can be compared with:

```sh
ALPHACHIP_PLC=<run_dir>/run_00/eval_output/rl_opt_placement.plc \
ALPHACHIP_COMPARE_DIR=/tmp/e1-alphachip/e1_softmacro_full/compare \
  scripts/alphachip/compare_proxy_costs.sh /tmp/e1-alphachip/e1_softmacro_full
```

## Next run

Run the full 256-soft-macro benchmark on a GPU host, preferably H200. Start with
short experiments to confirm placement export:

```sh
ALPHACHIP_BENCH_DIR=/tmp/e1-alphachip/e1_softmacro_full \
ALPHACHIP_RUN_DIR=/tmp/e1-alphachip/e1_softmacro_full_train \
USE_GPU=True \
NUM_COLLECT_JOBS=8 \
SEQUENCE_LENGTH=257 \
TRAIN_ITERATIONS=5 \
EPISODES_PER_ITERATION=16 \
PER_REPLICA_BATCH_SIZE=16 \
  scripts/alphachip/run_e1_softmacro_training.sh
```

Scale `TRAIN_ITERATIONS`, `EPISODES_PER_ITERATION`, and collect jobs after the
first exported `rl_opt_placement.plc` beats or approaches the OpenROAD-derived
proxy baseline.
