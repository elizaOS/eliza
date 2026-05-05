# Babylon Training & Benchmark - RunPod

Deploy Babylon RL training and benchmarks to [RunPod](https://runpod.io) cloud GPUs.

## Quick Start

### Training

```bash
# 1. Set API key
export RUNPOD_API_KEY="your-key"  # from https://runpod.io/console/user/settings

# 2. Configure environment
cp ../env.example .env
# Edit .env with DATABASE_URL, WANDB_API_KEY, etc.

# 3. Start training
python setup.py train --gpu h100 --gpus 2 --image yourorg/babylon-training:latest --env-file .env

# 4. Monitor
python setup.py list
python setup.py logs <pod-id>
```

### Shell Pod For Canonical Pipeline

```bash
# Provision a shell pod, SSH in, run the canonical pipeline manually, then stop it
python setup.py shell --gpu h200 --image yourorg/babylon-training:latest --env-file .env

# Or provision the recommended split-GPU box for 7B-9B RL/SFT runs
python setup.py shell --gpu a100 --gpus 2 --image yourorg/babylon-training:latest --env-file .env
```

### Benchmarking

```bash
# Benchmark a HuggingFace model (--base-model must match training!)
python setup.py benchmark \
  --gpu 4090 \
  --hf-model elizaos/gilgamesh-test-3060 \
  --base-model Qwen/Qwen2.5-0.5B-Instruct \
  --quick

# Use spot instance (cheaper)
python setup.py benchmark \
  --gpu 4090 \
  --hf-model elizaos/gilgamesh-test-3060 \
  --base-model Qwen/Qwen2.5-0.5B-Instruct \
  --spot --community
```

## Usage

### Using env file (recommended)

```bash
# Uses all settings from .env file
python setup.py train \
  --gpu h100 \
  --image yourorg/babylon-training:latest \
  --env-file .env
```

### Using CLI arguments

```bash
# Override specific settings
python setup.py train \
  --gpu h100 \
  --image yourorg/babylon-training:latest \
  --db "postgresql://..." \
  --wandb "your-wandb-key" \
  --steps 5000
```

### Spot instances (cheaper)

```bash
# Use spot instance (may be interrupted)
python setup.py train \
  --gpu 4090 \
  --image yourorg/babylon-training:latest \
  --env-file .env \
  --spot \
  --community
```

## Commands

```bash
# Start training pod
python setup.py train --gpu <type> --image <image> [options]

# Start benchmark pod
python setup.py benchmark --gpu <type> --hf-model <model> [options]

# List all pods
python setup.py list

# Stop and delete pod
python setup.py stop <pod-id>

# View logs (opens web console)
python setup.py logs <pod-id>
```

## GPU Options

| GPU | VRAM | Approx from-price | Best For |
|-----|------|-------|----------|
| `4090` | 24GB | Check RunPod live pricing | Small models, budget |
| `l40s` | 48GB | Check RunPod live pricing | Medium models |
| `a100` | 80GB | Check RunPod live pricing | Best value fallback for 7B-9B |
| `h100` | 80GB | Check RunPod live pricing | Balanced large-box training |
| `h200` | 141GB | Check RunPod live pricing | Simplest single-GPU 7B-9B run |

For the current Babylon stack:

- `a100 --gpus 2` is the best value configuration for 7B-9B RL because it cleanly splits vLLM and training across GPUs.
- `h200 --gpus 1` is the simplest single-box configuration when you want training and inference on one card.
- `h100 --gpus 2` is the balanced high-throughput recommendation if you want a faster large-machine run without jumping to 4 GPUs.

## Train Options

```
--gpu         GPU type (required): 4090, l40s, a100, h100, h200
--image       Docker image (required)
--env-file    Path to .env file (recommended)
--hf-dataset  HuggingFace dataset ID (recommended for cloud)
--name        Pod name (default: babylon-<gpu>)
--gpus        Number of GPUs (default: 1, auto-selects multi-GPU profiles when available)
--steps       Training steps (default: from env or 1000)
--profile     Training profile (default: auto from GPU)
--volume-gb   Persistent volume size in GB (default: auto from GPU/count)
--container-disk-gb  Container disk size in GB (default: auto from GPU/count)
--min-agents-per-window  Min trajectories per window (default: 1)
--wandb       WANDB_API_KEY (overrides env file)
--hf-token    HF_TOKEN (overrides env file)
--spot        Use spot instance (cheaper, may interrupt)
--community   Use community cloud (cheaper)
```

## Shell Pod Options

```
python setup.py shell --gpu <type> --image <image> [options]

--gpu         GPU type (required): 4090, l40s, a100, h100, h200
--gpus        Number of GPUs (default: 1, auto-selects multi-GPU profiles when available)
--profile     Suggested training profile (default: auto from GPU/count)
--volume-gb   Persistent volume size in GB (default: auto from GPU/count)
--container-disk-gb  Container disk size in GB (default: auto from GPU/count)
--env-file    Path to .env file (recommended)
--db          DATABASE_URL (overrides env file)
--spot        Use spot instance (cheaper, may interrupt)
--community   Use community cloud (cheaper)
```

## Benchmark Options

```
--gpu         GPU type (required): 4090, l40s, a100, h100, h200
--hf-model    HuggingFace model ID to benchmark (e.g., elizaos/gilgamesh-test-3060)
--base-model  Base model for vLLM (must match training, e.g., Qwen/Qwen2.5-0.5B-Instruct)
--model       Path to model inside container (alternative to --hf-model)
--image       Docker image (default: revlentless/babylon-benchmark:latest)
--env-file    Path to .env file
--name        Pod name (default: babylon-bench-<gpu>)
--hf-token    HF_TOKEN for private models
--quick       Quick mode - 7-day scenarios (faster)
--scenario    Specific scenario: bull-market, bear-market, scandal-unfolds, pump-and-dump
--spot        Use spot instance (cheaper, may interrupt)
--community   Use community cloud (cheaper)
```

## Environment Configuration

Uses the master [`../env.example`](../env.example). Key variables:

| Variable | Description |
|----------|-------------|
| `RUNPOD_API_KEY` | RunPod API access (required) |
| `HF_TOKEN` | Private model/dataset access (required for private repos) |
| `WANDB_API_KEY` | Experiment tracking |
| `HF_TRAJECTORY_DATASET` | HuggingFace dataset for training data |

### Data Source Note

**RunPod pods often cannot reach local/private databases.** Use `--hf-dataset` to load training data from HuggingFace instead:

```bash
python setup.py train \
  --gpu h100 \
  --image yourorg/babylon-training:latest \
  --env-file .env \
  --hf-dataset elizaos/enkidu-trajectories-raw
```

## Example Workflows

### Training Workflow

```bash
# 1. Build and push image
cd packages/training/deploy/docker
./build.sh training -o yourorg -t latest
./build.sh push-training -o yourorg -t latest

# 2. Configure
cp ../env.example .env
# Edit .env with HF_TOKEN, WANDB_API_KEY, RUNPOD_API_KEY

# 3. Deploy
cd ../runpod
python setup.py train --gpu h100 --gpus 2 --image yourorg/babylon-training:latest --env-file ../.env

# 4. Monitor at https://runpod.io/console/pods

# 5. Clean up when done
python setup.py list
python setup.py stop <pod-id>
```

### Ephemeral Large-Machine Workflow

```bash
# 1. Provision a shell pod
python setup.py shell --gpu a100 --gpus 2 --image yourorg/babylon-training:latest --env-file ../.env

# 2. SSH into the pod from the RunPod console

# 3. Inside the pod, run the canonical pipeline manually
cd /app
python3 python/scripts/run_pipeline.py \
  --mode full \
  --model Qwen/Qwen3.5-9B \
  --output /workspace/babylon-output \
  --local-backend cuda \
  --local-steps 200 \
  --local-batch-size 2 \
  --rl-steps 1000 \
  --rl-batch-size 8

# 4. Copy artifacts off the pod
# 5. Stop the pod
python setup.py stop <pod-id>
```

### Benchmark Workflow

```bash
# 1. Benchmark a trained model on HuggingFace
python setup.py benchmark \
  --gpu 4090 \
  --hf-model elizaos/gilgamesh-test-3060 \
  --base-model Qwen/Qwen2.5-0.5B-Instruct \
  --quick

# 2. Run full benchmark suite (all scenarios)
python setup.py benchmark \
  --gpu h100 \
  --hf-model elizaos/gilgamesh-test-h100 \
  --base-model Qwen/Qwen2.5-14B-Instruct

# 3. Run specific scenario
python setup.py benchmark \
  --gpu 4090 \
  --hf-model elizaos/gilgamesh-test-3060 \
  --base-model Qwen/Qwen2.5-0.5B-Instruct \
  --scenario bear-market \
  --spot

# 4. Monitor and clean up
python setup.py list
python setup.py stop <pod-id>
```

## Troubleshooting

### Pod won't start

- Check image exists and is accessible
- Verify GPU type is available
- Check RunPod console for error messages

### Training fails

- SSH into pod or check logs in console
- Verify DATABASE_URL is accessible from RunPod
- Check CUDA/GPU availability

### Benchmark fails

- Ensure HF_TOKEN is set for private models
- Check that the model exists on HuggingFace
- Verify GPU has enough VRAM for the model
- Check vLLM logs in the pod console

## Benchmark Scenarios

| Scenario | Duration | Condition | Tests |
|----------|----------|-----------|-------|
| `bull-market` | 22 days | Bull | Basic competence |
| `bear-market` | 22 days | Bear | Capital protection |
| `scandal-unfolds` | 22 days | Scandal | Information processing |
| `pump-and-dump` | 22 days | Volatile | Skepticism |

## Related

- [Master Environment Config](../env.example)
- [Docker Images](../docker/README.md)
- [Large GPU Runbook](../LARGE_GPU_RUNBOOK.md)
- [Local Development](../local/README.md)
- [Phala Cloud (TEE)](../phala/README.md)
