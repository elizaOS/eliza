# Babylon RL Training - Deployment

This directory contains everything needed to deploy Babylon RL training to various platforms.

## Quick Start

```bash
# 1. Copy and configure environment
cp env.example .env
# Edit .env with your DATABASE_URL, etc.

# 2. Build and push Docker images
cd docker
./build.sh all -t 0.2.0,latest

# 3. Run locally
cd ../local
./run.sh --profile 12gb --steps 100
```

## Directory Structure

```
deploy/
├── env.example       # Master environment config (copy to .env)
├── README.md         # This file
├── docker/           # Docker images
│   ├── Dockerfile.base   # Base image with vLLM + FlashInfer
│   ├── Dockerfile        # Production training image
│   ├── Dockerfile.bench  # Benchmark image with vLLM
│   ├── build.sh          # Build/push CLI
│   ├── scripts/          # Container scripts
│   └── README.md
├── local/            # Local development scripts
│   ├── run.sh            # Quick local training
│   ├── benchmark.sh      # Run benchmarks in Docker
│   └── README.md
├── runpod/           # RunPod cloud deployment
│   ├── setup.py          # CLI for RunPod pods
│   └── README.md
└── phala/            # Phala Cloud (TEE) deployment
    ├── docker-compose.yml
    ├── scripts/          # Attestation, secrets, deploy
    └── README.md
```

## Deployment Options

| Platform | GPU Support | Best For | Setup Time |
|----------|-------------|----------|------------|
| **Local Docker** | Your GPU | Development, testing | 5 min |
| **RunPod** | RTX 4090, A100, H100, H200 | Ephemeral large-GPU training | 10 min |
| **Phala Cloud** | TEE-enabled GPUs | Privacy-preserving training | 15 min |

## Environment Configuration

All platforms use the same environment variables. See [`env.example`](./env.example) for the complete list.

**Required (choose one data source):**
- `DATABASE_URL` - PostgreSQL with trajectory data (default)
- Or `TRAJECTORY_SOURCE=huggingface` + `HF_TRAJECTORY_DATASET` - Load from HuggingFace dataset

**Recommended:**
- `WANDB_API_KEY` - Experiment tracking
- `HF_TOKEN` - For private/gated models and pushing to HuggingFace

**Optional Post-Training:**
- `HF_PUSH_REPO` - Push trained model to HuggingFace Hub
- `BENCHMARK_ENABLED=true` - Run benchmark suite after training

## GPU Profiles

The training supports various GPU configurations:

| Profile | GPU | VRAM | Model | Use Case |
|---------|-----|------|-------|----------|
| `12gb` | RTX 3060/4070 | 12GB | Qwen2.5-0.5B | Local dev |
| `24gb` | RTX 3090/4090 | 24GB | Qwen2.5-1.5B | Local/Cloud |
| `l40` | L40S | 48GB | Qwen2.5-14B | Cloud |
| `a100` | A100 | 80GB | Qwen3.5-9B | Value single GPU |
| `a100-2gpu` | 2x A100 | 160GB | Qwen3.5-9B | Best value for 7B-9B RL |
| `h100` | H100 | 80GB | Qwen2.5-14B | Large single GPU |
| `h100-2gpu` | 2x H100 | 160GB | Qwen3.5-9B | Recommended balanced large box |
| `h200` | H200 | 141GB | Qwen3.5-9B | Simplest one-box 7B-9B run |
| `h200-2gpu` | 2x H200 | 282GB | Qwen3.5-9B | Fastest single-node 7B-9B run |

## Docker Images

We use a **multi-stage build** for faster iteration:

1. **Base Image** (`Dockerfile.base`) - Built once, ~10 min
   - Uses official `vllm/vllm-openai:v0.14.0`
   - Includes FlashInfer attention (no flash-attn compilation!)
   - All ML dependencies pre-installed

2. **Training Image** (`Dockerfile`) - Built per-change, ~2 min
   - Extends base image
   - Adds your training code
   - Optionally pre-downloads model weights

3. **Benchmark Image** (`Dockerfile.bench`) - ~5 min
   - Standalone vLLM server + TypeScript benchmark
   - Supports LoRA adapters via volume mounts
   - Supports HuggingFace model downloads

```bash
cd docker

# Build and push everything (base + training + benchmark)
./build.sh all -t 0.2.0,latest

# Or step by step
./build.sh base -t 0.2.0,latest
./build.sh training -t 0.2.0,latest
./build.sh benchmark -t 0.2.0,latest

# Different org
./build.sh all -o myorg -t 1.0.0
```

## HuggingFace Integration

### Loading Trajectories from HuggingFace

Instead of a live database, you can train on frozen HuggingFace datasets:

```bash
# Set trajectory source to HuggingFace
export TRAJECTORY_SOURCE=huggingface
export HF_TRAJECTORY_DATASET=elizaos/babylon-trajectories-simulation-v1
export HF_TRAJECTORY_SPLIT=raw

# Run training
./local/run.sh --profile 12gb --steps 100
```

### Pushing Models to HuggingFace

After training, push your model to HuggingFace Hub:

```bash
# Set push configuration
export HF_PUSH_REPO=elizaos/ishtar-qwen2.5-3b-grpo-v0.1
export HF_MODEL_CODENAME=ishtar
export HF_TOKEN=your-token

# Run training (will push at the end)
./local/run.sh --profile 24gb --steps 1000
```

Model codenames are Babylon-inspired: `ishtar`, `marduk`, `gilgamesh`, `enkidu`, `tiamat`, etc.

## Post-Training Benchmark

Run benchmarks on trained models using the containerized benchmark runner:

```bash
cd local

# Quick benchmark with trained model
./benchmark.sh

# Benchmark specific checkpoint
./benchmark.sh --model step_500

# Full benchmark (22-day scenarios)
./benchmark.sh --full

# Specific scenario
./benchmark.sh --scenario bear-market

# Or via Makefile
make local-benchmark
make local-benchmark-quick
```

The benchmark image uses vLLM to run inference on your trained model against fixed scenarios (bull-market, bear-market, scandal-unfolds, pump-and-dump).

## Platform Guides

- **[Local Development](./local/README.md)** - Run training on your local GPU
- **[Docker](./docker/README.md)** - Building and configuring images
- **[RunPod](./runpod/README.md)** - Cloud GPU training
- **[Large GPU Runbook](./LARGE_GPU_RUNBOOK.md)** - Recommended large-machine configurations and ephemeral workflow
- **[Phala Cloud](./phala/README.md)** - TEE-enabled privacy-preserving training
