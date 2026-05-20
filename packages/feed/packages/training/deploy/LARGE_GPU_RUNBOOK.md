# Large GPU Runbook

This runbook is for short-lived cloud machines that should be provisioned, used for one serious training pass, and then shut down.

## Recommendation Matrix

For the current Babylon stack, raw VRAM is not the only constraint. The RL path benefits from running vLLM and the trainer at the same time, so split-GPU configurations are often better than the biggest single card.

| Goal | Recommended Box | Why |
|------|-----------------|-----|
| Best value for 7B-9B RL/SFT | `2x A100 80GB` | One GPU for vLLM, one for training, usually cheaper than a single H200 |
| Simplest single-box 7B-9B run | `1x H200 141GB` | Enough headroom to co-host vLLM and training on one GPU |
| Best balanced high-throughput single node | `2x H100 80GB` | Clean split between inference and training with strong Hopper throughput |
| Fastest single-node 7B-9B run | `2x H200 141GB` | Maximum headroom for long context, bigger batches, and benchmark serving |

Use the new training profiles:

- `a100`
- `a100-2gpu`
- `h100`
- `h100-2gpu`
- `h200`
- `h200-2gpu`

## What To Provision

### Recommended immediate path

Use the RunPod deployment path that already exists in this repo.

- It is the only provider with repo-native automation today.
- It now supports a shell-style pod for manual canonical pipeline runs.
- It auto-selects the right profile for common 1/2/4-GPU combinations.

### Provider choice

If you want the fastest path from this repo to a live box, use RunPod now.

If you later want to optimize pure price or reserved capacity:

- Nebius is attractive for reserved H200/H100 capacity and Terraform workflows.
- Hyperstack is attractive on raw hourly price.

Those can be better infrastructure choices, but they are not integrated into this repo yet.

## Build And Push The Image

```bash
cd /Users/shawwalters/babylon-workspace/babylon/packages/training/deploy/docker
./build.sh all -o yourorg -t latest
```

Use a pinned tag for real runs if you need reproducibility.

## Provision A Shell Pod

This is the recommended flow when you want to run the canonical pipeline manually, inspect logs, copy artifacts, and shut the box down.

### Best-value box

```bash
cd /Users/shawwalters/babylon-workspace/babylon/packages/training/deploy/runpod
python setup.py shell \
  --gpu a100 \
  --gpus 2 \
  --image yourorg/babylon-training:latest \
  --env-file ../.env
```

### Simplest single-box H200

```bash
cd /Users/shawwalters/babylon-workspace/babylon/packages/training/deploy/runpod
python setup.py shell \
  --gpu h200 \
  --image yourorg/babylon-training:latest \
  --env-file ../.env
```

### Balanced large box

```bash
cd /Users/shawwalters/babylon-workspace/babylon/packages/training/deploy/runpod
python setup.py shell \
  --gpu h100 \
  --gpus 2 \
  --image yourorg/babylon-training:latest \
  --env-file ../.env
```

After the pod is live, SSH into it from the RunPod console.

## Run The Canonical Pipeline

Inside the pod:

```bash
cd /app
python3 python/scripts/run_pipeline.py \
  --mode full \
  --model Qwen/Qwen3.5-9B \
  --output /workspace/babylon-output \
  --local-backend cuda \
  --local-steps 200 \
  --local-batch-size 2 \
  --lookback-hours 168 \
  --max-trajectories 500 \
  --rl-steps 1000 \
  --rl-batch-size 8
```

For a single H200, start here:

```bash
cd /app
python3 python/scripts/run_pipeline.py \
  --mode full \
  --model Qwen/Qwen3.5-9B \
  --output /workspace/babylon-output \
  --local-backend cuda \
  --local-steps 150 \
  --local-batch-size 1 \
  --lookback-hours 168 \
  --max-trajectories 500 \
  --rl-steps 750 \
  --rl-batch-size 4
```

## Run Direct RL Training

If you only want the RL runner instead of the full canonical pipeline:

```bash
cd /app
python3 python/scripts/run_training.py --profile a100-2gpu --steps 1000
```

Swap the profile as needed:

- `a100-2gpu`
- `h100-2gpu`
- `h200`
- `h200-2gpu`

## Artifacts To Pull Before Shutdown

Copy these off the pod before stopping it:

- `/workspace/babylon-output/pipeline_report.json`
- `/workspace/babylon-output/training_manifest.json`
- `/workspace/babylon-output/served_eval.json`
- `/workspace/babylon-output/scambench_results.json`
- `/workspace/babylon-output/adapters/`
- `/workspace/babylon-output/materialized_models/`

If you ran the RL-only path, also copy:

- `/app/trained_models/`
- `/app/logs/`

## Teardown

When the artifacts are copied out and the run is complete:

```bash
cd /Users/shawwalters/babylon-workspace/babylon/packages/training/deploy/runpod
python setup.py list
python setup.py stop <pod-id>
```

Do not leave the pod running after artifacts have been copied.

## Pre-Run Checklist

- `RUNPOD_API_KEY` is set or present in `deploy/.env`
- Either `DATABASE_URL` points to reachable trajectory data or `TRAJECTORY_SOURCE=huggingface` plus `HF_TRAJECTORY_DATASET` is configured
- `HF_TOKEN` is set if the base model is gated
- `WANDB_API_KEY` is set if you want online experiment tracking
- The Docker image tag is pinned and pushed
- The target model and trajectory volume fit the chosen box
