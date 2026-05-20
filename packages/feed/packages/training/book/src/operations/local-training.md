# Local Training

Run the full training pipeline on your local machine.

## Prerequisites

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| Python | 3.10 | 3.11 |
| CUDA | 11.8 | 12.1 |
| GPU VRAM | 12GB | 24GB |
| RAM | 16GB | 32GB |
| Disk | 20GB | 50GB |

## Quick Start

```bash
cd packages/training

# 1. Setup Python environment (one-time)
make venv

# 2. Start database (if using DB mode)
make db-up

# 3. Run training
make train-12gb
```

## Step-by-Step

### 1. Create Virtual Environment

```bash
cd packages/training
make venv
```

This runs:

```bash
cd python && python3 -m venv venv
pip install -r requirements.txt
pip install -e .
```

### 2. Activate Environment

```bash
source python/venv/bin/activate
```

### 3. Start Test Database (Optional)

For DB mode training:

```bash
make db-up
```

This starts PostgreSQL on port 5434 via Docker Compose.

For JSON mode (no DB needed):

```bash
# Just run training directly
python scripts/run_training.py --profile 12gb --skip-validation
```

### 4. Generate Training Data

If you need fresh data:

```bash
# Generate trajectories (2 hours simulation)
bun run packages/engine/examples/generate-training-data.ts --causal --hours 2

# Import to database
make tier4-import
```

### 5. Run Training

```bash
# Using make shortcuts
make train-12gb   # 12GB GPU
make train-24gb   # 24GB GPU
make train-l40    # L40 48GB

# Or specify profile
make train PROFILE=16gb

# Or run directly
cd python
python scripts/run_training.py --profile 12gb --steps 100
```

## Training Configuration

### Common Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--profile` | (required) | GPU profile name |
| `--steps` | 100 | Training steps |
| `--batch-size` | From profile | Override batch size |
| `--lr` | 1e-5 | Learning rate |
| `--save-every` | 5 | Checkpoint interval |
| `--no-wandb` | False | Disable W&B |

### Full Example

```bash
python scripts/run_training.py \
  --profile 24gb \
  --steps 500 \
  --lr 5e-6 \
  --lr-scheduler cosine \
  --warmup-steps 20 \
  --save-every 10 \
  --no-wandb
```

## Monitoring Training

### Terminal Output

```text
2025-01-13 10:00:00 [INFO] Starting training with profile: 12gb
2025-01-13 10:00:05 [INFO] Loaded 150 trajectories from database
2025-01-13 10:00:10 [INFO] vLLM server started on port 8001
2025-01-13 10:00:15 [INFO] Step 1/100 - Loss: 0.342, LR: 1e-5
2025-01-13 10:00:30 [INFO] Step 2/100 - Loss: 0.315, LR: 9.9e-6
...
2025-01-13 10:05:00 [INFO] Step 5/100 - Saved checkpoint to trained_models/step_5
```

### GPU Usage

In another terminal:

```bash
watch -n 1 nvidia-smi
```

Expected usage:
- Training process: 40-60% VRAM
- vLLM process: 20-35% VRAM
- Total: 70-85% VRAM

### Weights & Biases (Optional)

```bash
# Enable W&B
export WANDB_API_KEY=your_key
python scripts/run_training.py --profile 12gb
```

View at: [W&B Dashboard](https://wandb.ai/your-team/babylon-training)

## Checkpoints

Saved to `python/trained_models/`:

```text
trained_models/
├── step_5/
│   ├── model.safetensors
│   ├── config.json
│   ├── tokenizer.json
│   ├── tokenizer_config.json
│   └── optimizer.pt
├── step_10/
└── final_model/
```

### Resume from Checkpoint

```bash
python scripts/run_training.py \
  --profile 12gb \
  --resume ./trained_models/step_50 \
  --steps 100
```

This continues from step 51.

## Long-Running Training (Hours/Days)

For training runs that take hours or days, use tmux to survive SSH disconnects.

### Start Training in tmux

```bash
# Create named session
tmux new -s train

# Activate venv and start training
cd packages/training
source python/venv/bin/activate
python scripts/run_training.py \
  --profile 12gb \
  --steps 500 \
  2>&1 | tee training.log
```

**Detach**: `Ctrl+B`, then `D`

**Reattach after SSH reconnect**:

```bash
tmux attach -t train
```

### Alternative: nohup

```bash
cd packages/training
source python/venv/bin/activate

nohup python scripts/run_training.py \
  --profile 12gb \
  --steps 500 \
  > training.log 2>&1 &

echo $! > train.pid
```

**Monitor**:

```bash
tail -f training.log
nvidia-smi  # Check GPU usage
```

### Recommended Steps for Different Durations

| Duration | Steps | Expected Quality |
|----------|-------|------------------|
| 1 hour | 100-200 | Basic patterns |
| 4 hours | 500-800 | Good for eval |
| 8 hours | 1000-1500 | Production candidate |
| 24 hours | 3000+ | Best quality |

### Checkpoints

Training saves checkpoints every 10 steps by default:

```text
trained_models/
├── step_10/
├── step_20/
├── step_30/
└── ...
```

If training crashes, resume from the last checkpoint:

```bash
python scripts/run_training.py --profile 12gb --resume ./trained_models/step_30
```

## Common Issues

### CUDA Out of Memory

```text
RuntimeError: CUDA out of memory
```

**Fix**: Use smaller profile or reduce batch size:

```bash
python scripts/run_training.py --profile 12gb --batch-size 1
```

### vLLM Startup Timeout

```text
TimeoutError: vLLM server did not start within 120s
```

**Fix**: Check GPU memory, or increase timeout:

```bash
export VLLM_STARTUP_TIMEOUT=300
python scripts/run_training.py --profile 12gb
```

### No Trajectories Found

```text
ValueError: No valid trajectory groups found
```

**Fix**: Generate or import data:

```bash
make tier4-generate
make tier4-import
```

### Database Connection Failed

```text
ConnectionRefusedError: [Errno 111] Connection refused
```

**Fix**: Start database:

```bash
make db-up
make db-migrate
```

## Testing Before Full Training

### Tier 1: Unit Tests (No GPU)

```bash
make tier1
```

### Tier 2: JSON Mode (No GPU)

```bash
make tier2
```

### Tier 4: Single Step GPU Test

```bash
make tier4
# Runs 1 training step to verify setup
```

## Resource Usage

### Typical 12GB GPU Training

| Metric | Value |
|--------|-------|
| GPU Util | 80-95% |
| GPU Memory | 10-11GB |
| RAM | 8-12GB |
| Disk (logs) | 100MB/hour |
| Time/step | 15-30s |

### Scaling Estimates

| GPU | Steps/Hour | Time for 100 Steps |
|-----|------------|-------------------|
| RTX 3060 12GB | 120 | 50 min |
| RTX 4090 24GB | 200 | 30 min |
| L40 48GB | 300 | 20 min |
