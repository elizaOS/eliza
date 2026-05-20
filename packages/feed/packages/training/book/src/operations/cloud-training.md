# Cloud Training

Deploy training to cloud GPU providers like RunPod, Lambda, or AWS.

## Cloud Providers

| Provider | GPUs | Approx Cost | Notes |
|----------|------|-------------|-------|
| RunPod | L40, A100 | $1-4/hr | Easy setup, good availability |
| Lambda Labs | A100, H100 | $1-3/hr | Good pricing, limited availability |
| Vast.ai | Various | $0.5-2/hr | Cheapest, variable quality |
| AWS | Various | $3-10/hr | Enterprise, most expensive |

## Docker Deployment

### Build Image

```bash
cd packages/training
make docker-build
```

This creates `babylon-training:latest` from the Dockerfile.

### Dockerfile Overview

```dockerfile
FROM nvidia/cuda:12.1-devel-ubuntu22.04

# Install Python 3.11
RUN apt-get update && apt-get install -y python3.11 python3.11-venv

# Setup venv
RUN python3.11 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install dependencies
COPY python/requirements.txt .
RUN pip install -r requirements.txt

# Copy code
COPY python/ /app/python/
COPY config/ /app/config/

WORKDIR /app/python

# Default command
CMD ["python", "scripts/run_training.py", "--profile", "l40"]
```

### Push to Registry

```bash
# Tag for your registry
docker tag babylon-training:latest your-registry/babylon-training:latest

# Push
docker push your-registry/babylon-training:latest
```

## RunPod Setup

### 1. Create Pod

1. Go to [runpod.io](https://runpod.io)
2. Select GPU: L40 (48GB) recommended
3. Choose template: PyTorch 2.0+ CUDA 12.1
4. Set volume: 50GB minimum

### 2. SSH into Pod

```bash
ssh root@<pod-ip> -p <port>
```

### 3. Clone and Setup

```bash
git clone https://github.com/BabylonSocial/babylon.git
cd babylon/packages/training

# Setup Python
make venv

# Or use Docker
docker run --gpus all -it babylon-training:latest
```

### 4. Configure Environment

```bash
# Required
export DATABASE_URL=postgresql://user:pass@host:port/db

# Optional
export WANDB_API_KEY=your_key
export OPENAI_API_KEY=sk-...  # For LLM judge
```

### 5. Run Training

```bash
make train-l40

# Or with W&B
make train-cloud PROFILE=l40
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes* | PostgreSQL connection string |
| `WANDB_API_KEY` | No | Weights & Biases logging |
| `OPENAI_API_KEY` | No | LLM judge (evaluation only) |
| `CUDA_VISIBLE_DEVICES` | No | GPU selection (multi-GPU) |
| `WANDB_PROJECT` | No | W&B project name |
| `WANDB_ENTITY` | No | W&B team/user |

*Not required if using exported JSON data.

## Database Connection

### Option 1: Connect to Remote DB

Point `DATABASE_URL` to your staging/production database:

```bash
export DATABASE_URL=postgresql://user:pass@staging.example.com:5432/babylon
```

### Option 2: Export Data Locally

Export trajectories from production, train offline:

```bash
# On machine with DB access
python scripts/export_trajectories.py --output ./training-data.json

# Copy to cloud
scp training-data.json root@runpod:/data/

# Train with JSON mode (no DB needed)
python scripts/run_training.py --profile l40 --data-source /data/training-data.json
```

### Option 3: Tunnel

SSH tunnel to database:

```bash
ssh -L 5432:db-host:5432 bastion-host

# Then use localhost
export DATABASE_URL=postgresql://user:pass@localhost:5432/babylon
```

## Multi-GPU Training

### 2x L40 (96GB)

```bash
make train-l40-2gpu

# Or manually
python scripts/run_training.py --profile l40-2gpu
```

Profile sets `tensor_parallel: 2`, vLLM handles distribution.

### 4x L40 (192GB)

```bash
make train-l40-4gpu

# Trains Qwen 30B model
```

### GPU Selection

```bash
# Use specific GPUs
export CUDA_VISIBLE_DEVICES=0,1
make train-l40-2gpu
```

## Monitoring

### W&B Dashboard

Best for cloud training - all metrics logged remotely:

```bash
export WANDB_API_KEY=your_key
python scripts/run_training.py --profile l40 \
  --wandb-project babylon-training \
  --wandb-entity your-team
```

View at: https://wandb.ai/your-team/babylon-training

### SSH + tmux

Keep training running after disconnect:

```bash
# Start tmux session
tmux new -s training

# Run training
make train-l40

# Detach: Ctrl+B then D

# Reattach later
tmux attach -t training
```

### Logs

```bash
# Follow logs
tail -f python/logs/training.log

# Or with Docker
docker logs -f container_id
```

## Cost Optimization

### Spot Instances

Use spot/interruptible instances (50-70% savings):

```bash
# RunPod: Select "Spot" when creating pod
# AWS: Use spot instances
# Lambda: Interruptible instances
```

Enable checkpointing to resume after interruption:
```bash
python scripts/run_training.py --profile l40 --save-every 1
```

### Right-size GPU

| Training Goal | Recommended GPU |
|---------------|-----------------|
| Quick iteration | L40 (48GB) |
| Production model | 2x L40 |
| Large model (30B) | 4x L40 |

### Batch Size Tuning

Larger batch = better GPU utilization:

```bash
# Test maximum batch size
python scripts/run_training.py --profile l40 --batch-size 16 --steps 1
```

If OOM, reduce batch size.

## Makefile Cloud Targets

```makefile
# Cloud training with W&B
make train-cloud PROFILE=l40

# Specific GPU configs
make train-cloud-l40
make train-cloud-l40-2gpu
make train-cloud-l40-4gpu

# Online training in cloud
make train-cloud-online PROFILE=l40
```

## Saving Results

### Download Checkpoints

```bash
# From RunPod
scp -r root@pod:/app/python/trained_models ./

# Or compress first
tar czf model.tar.gz trained_models/final_model
scp root@pod:/app/python/model.tar.gz ./
```

### Push to HuggingFace

```bash
# Install huggingface-cli
pip install huggingface_hub

# Login
huggingface-cli login

# Upload
huggingface-cli upload your-org/babylon-trader ./trained_models/final_model
```

