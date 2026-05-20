# Babylon Training - Local Development

Run Babylon RL training locally with Docker.

## Prerequisites

1. **NVIDIA GPU** with CUDA support
2. **Docker** with [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
3. **Built Docker image** (or pull from registry)

## Quick Start

```bash
# 1. Configure environment
cp ../env.example ../.env
# Edit .env with your DATABASE_URL

# 2. Run training
./run.sh --profile 12gb --steps 100
```

## Usage

```bash
# Basic run with defaults
./run.sh

# Specify GPU profile and steps
./run.sh --profile 12gb --steps 100

# Use specific image
./run.sh --image yourorg/babylon-training:latest

# Interactive shell (for debugging)
./run.sh --interactive

# Pass extra arguments to training script
./run.sh --profile 12gb -- --learning-rate 1e-5
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--image <image>` | Docker image | `revlentless/babylon-training:latest` |
| `--env-file <path>` | Environment file | `deploy/.env` (relative to training root) |
| `--profile <profile>` | GPU profile | `12gb` |
| `--steps <n>` | Training steps | `100` |
| `--interactive, -i` | Start bash shell | - |

## GPU Profiles

| Profile | GPU | VRAM | Model |
|---------|-----|------|-------|
| `12gb` | RTX 3060/4070 | 12GB | Qwen2.5-0.5B |
| `24gb` | RTX 3090/4090 | 24GB | Qwen2.5-1.5B |
| `l40` | L40S | 48GB | Qwen2.5-7B |
| `a100` | A100 | 80GB | Qwen2.5-14B |
| `h100` | H100 | 80GB | Qwen2.5-14B |

## Environment Variables

You can also configure via environment:

```bash
export BABYLON_IMAGE="yourorg/babylon-training:latest"
export BABYLON_PROFILE="24gb"
export BABYLON_STEPS="500"

./run.sh
```

## Volume Mounts

The script automatically mounts:

| Host Path | Container Path | Purpose |
|-----------|----------------|---------|
| `../../trained_models` | `/app/python/trained_models` | Model checkpoints |
| `../../logs` | `/app/logs` | Training logs |

## Post-Training Actions

### Push Model to HuggingFace

Set these environment variables before training:

```bash
export HF_PUSH_REPO=elizaos/ishtar-qwen2.5-3b-grpo-v0.1
export HF_MODEL_CODENAME=ishtar
export HF_TOKEN=your-hf-token

./run.sh --profile 24gb --steps 1000
# Model will be pushed to HuggingFace after training completes
```

### Run Benchmark

After training, run benchmarks in a containerized environment:

```bash
# Quick benchmark with trained model (base-model must match training!)
./benchmark.sh --model gilgamesh-local-001 --base-model Qwen/Qwen2.5-0.5B-Instruct

# Benchmark specific checkpoint
./benchmark.sh --model step_500 --base-model Qwen/Qwen2.5-0.5B-Instruct

# Specific scenario
./benchmark.sh --model gilgamesh-local-001 --scenario bear-market

# Full benchmark (22-day scenarios)
./benchmark.sh --model gilgamesh-local-001 --full

# Interactive shell for debugging
./benchmark.sh --interactive
```

Benchmark results are saved to `../../benchmark-results/`.

## Benchmark Options

| Option | Description | Default |
|--------|-------------|---------|
| `--image <image>` | Docker image | `revlentless/babylon-benchmark:latest` |
| `--model <name>` | Model in trained_models/ | `final_model` |
| `--base-model <name>` | Base model for vLLM (must match training!) | `Qwen/Qwen2.5-0.5B-Instruct` |
| `--hf-model <id>` | HuggingFace model to benchmark | - |
| `--scenario <id>` | Specific scenario | all |
| `--quick` | Quick mode (7-day scenarios) | default |
| `--full` | Full mode (22-day scenarios) | - |
| `--output <dir>` | Results directory | `../../benchmark-results` |
| `--interactive, -i` | Interactive shell | - |

### Available Scenarios

| Scenario | Description |
|----------|-------------|
| `bull-market` | Strong upward price trend |
| `bear-market` | Downward trend with volatility |
| `scandal-unfolds` | FUD event causes price drop |
| `pump-and-dump` | Pump followed by crash |

## Troubleshooting

### GPU not detected

```bash
# Test GPU access
docker run --gpus all nvidia/cuda:12.1.0-base nvidia-smi
```

If this fails, install NVIDIA Container Toolkit.

### Port conflicts

If you get port conflicts (e.g., MinIO on 9001), kill the conflicting process:

```bash
sudo fuser -k 9001/tcp
```

### Database connection failed

Ensure `DATABASE_URL` in your `.env` is accessible from the container.
With `--network host`, the container uses host networking.

## Related

- [Environment Configuration](../env.example)
- [Docker Images](../docker/README.md)

