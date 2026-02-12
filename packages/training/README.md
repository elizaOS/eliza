# Babylon Training Pipeline

> **⚠️ Experimental** - Under active development. APIs may change.

RL training for Babylon agents using trajectory-based learning with GRPO (Group Relative Policy Optimization).

## Quick Start

### 1. Generate Trajectories

```bash
bun run dev  # Start server first

babylon train parallel --archetypes trader --num-agents 5 --ticks 20
```

### 2. Train Locally

```bash
cd packages/training/python
python3.11 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Run full training pipeline (starts services, trains, logs to W&B)
python scripts/run_training.py --steps 100
```

## Local GRPO Training

The local training pipeline uses the Atropos framework for GRPO-based RL training.

### Prerequisites

1. **Python 3.11+** with CUDA support
2. **PostgreSQL** with trajectory data
3. **GPU** with at least 12GB VRAM (for 3B model)

### Quick Run

```bash
cd packages/training/python
source venv/bin/activate

# Full pipeline (recommended)
python scripts/run_training.py --steps 100

# Or run components separately:
# Terminal 1: Atropos API
run-api --port 8000

# Terminal 2: Babylon Environment
python -m src.training.babylon_env serve --slurm false

# Terminal 3: GRPO Trainer
python -m src.training.atropos_trainer --steps 100
```

### Training Configuration

| Flag | Description | Default |
|------|-------------|---------|
| `--steps` | Training steps | `100` |
| `--batch-size` | Batch size | `4` |
| `--lr` | Initial learning rate | `1e-5` |
| `--min-lr` | Minimum learning rate | `1e-7` |
| `--lr-scheduler` | LR scheduler: constant, linear, cosine | `cosine` |
| `--warmup-steps` | Warmup steps | `10` |
| `--model` | Base model | `Qwen/Qwen2.5-3B-Instruct` |
| `--save-path` | Checkpoint directory | `./trained_models` |
| `--save-every` | Save checkpoint every N steps | `5` |
| `--resume` | Resume from checkpoint path | - |

### Weights & Biases Integration

W&B logging is **optional** and works in offline mode if no API key is set.

```bash
# With W&B (online)
export WANDB_API_KEY=your_key
python scripts/run_training.py --steps 100 --wandb-project babylon-training

# Offline mode (automatic if no API key)
python scripts/run_training.py --steps 100

# Disable W&B entirely
python scripts/run_training.py --steps 100 --no-wandb
```

#### Tracked Metrics

| Metric | Description |
|--------|-------------|
| `train/loss` | GRPO training loss |
| `train/learning_rate` | Current learning rate |
| `train/grad_norm` | Gradient norm |
| `train/pos_logp` | Log prob for positive advantages |
| `train/neg_logp` | Log prob for negative advantages |
| `train/aiJudgeReward` | Average AI Judge composite score |
| `train/format_score` | Average format quality score |
| `train/reasoning_score` | Average reasoning quality score |

### Resume from Checkpoint

```bash
# Resume training from a checkpoint
python scripts/run_training.py --resume ./trained_models/step_50

# Or with full control
python -m src.training.atropos_trainer \
  --resume ./trained_models/step_50 \
  --steps 100
```

### Learning Rate Schedules

Three schedules are available:

| Schedule | Description |
|----------|-------------|
| `constant` | Fixed learning rate |
| `linear` | Linear decay from initial to min LR |
| `cosine` | Cosine annealing from initial to min LR (default) |

All schedules support warmup:

```bash
python scripts/run_training.py \
  --lr 1e-5 \
  --min-lr 1e-7 \
  --lr-scheduler cosine \
  --warmup-steps 10
```

## Hardware Requirements

| Platform | Backend | Model | VRAM |
|----------|---------|-------|------|
| Mac M1/M2 (16GB) | MLX | `mlx-community/Qwen2.5-1.5B-Instruct-4bit` | 8GB |
| Mac M1/M2 (32GB+) | MLX | `mlx-community/Qwen2.5-3B-Instruct-4bit` | 16GB |
| GTX 3060+ (12GB) | CUDA | `Qwen/Qwen2.5-1.5B-Instruct` | 12GB |
| GTX 4090 (24GB) | CUDA | `Qwen/Qwen2.5-3B-Instruct` | 20GB |
| Any | Tinker | Cloud-based | N/A |

## CLI Commands

### Generate Data

```bash
babylon train parallel --archetypes trader,degen --num-agents 3 --ticks 20
babylon train parallel -a all -n 2 -t 10      # All archetypes
babylon train parallel --dry-run               # Preview
```

| Flag | Description | Default |
|------|-------------|---------|
| `-a, --archetypes` | Comma-separated or `all` | `trader` |
| `-n, --num-agents` | Agents per archetype | `2` |
| `-t, --ticks` | Ticks per agent | `10` |
| `-p, --parallel` | Max concurrent agents | `5` |
| `--cleanup` | Delete agents after | `false` |

### Score & Export

```bash
babylon train score                           # Score all trajectories
babylon train archetype -a trader             # Score + export for archetype
babylon train archetype -a trader --score-only
```

### Train

```bash
babylon train pipeline -a trader              # Full pipeline
babylon train run -a all                      # All archetypes
```

## Python Training

### Local Training

```bash
cd packages/training/python
source venv/bin/activate

python scripts/train_local.py                 # Auto-detect backend
python scripts/train_local.py --backend mlx   # Force MLX
python scripts/train_local.py --backend cuda  # Force CUDA
```

Options:
```bash
python scripts/train_local.py \
  --backend mlx \
  --model mlx-community/Qwen2.5-1.5B-Instruct-4bit \
  --output ./trained_models/my_model \
  --iters 100 \
  --batch-size 2 \
  --lr 1e-5 \
  --min-actions 3 \
  --lookback-hours 168 \
  --max-trajectories 500 \
  --validate
```

### Cloud Training (Tinker)

```bash
export TINKER_API_KEY=your_key
export DATABASE_URL=postgresql://...
export OPENAI_API_KEY=sk-...

python scripts/run_tinker_training.py --steps 100
```

## Archetypes

| Archetype | Description |
|-----------|-------------|
| `trader` | Disciplined profit-focused trader |
| `degen` | High-risk YOLO trader |
| `scammer` | Manipulative, spreads misinformation |
| `researcher` | Analytical, data-driven |
| `social-butterfly` | Community engagement focused |
| `information-trader` | News/signal-based |
| `perps-trader` | Perpetual futures specialist |
| `super-predictor` | Prediction market expert |
| `infosec` | Security-conscious |
| `goody-twoshoes` | Helpful, ethical |
| `ass-kisser` | Follows crowd consensus |
| `liar` | Consistently misleading |

## Architecture

```
Agent Trajectories → TrajectoryRecorder → Database
                                           ↓
                                  LLM-as-Judge Scoring (AI Judge)
                                           ↓
                                      GRPO Training
                                           ↓
                              W&B Logging (optional)
                                           ↓
                                    Trained Model
```

### Training Pipeline Components

| Component | Description |
|-----------|-------------|
| `ServiceManager` | Manages Atropos API and vLLM servers |
| `BabylonRLAIFEnv` | RLAIF environment for trajectory scoring |
| `BabylonAtroposTrainer` | GRPO trainer with LR scheduling |
| `run_training.py` | Orchestrates full pipeline |

### TypeScript (`src/`)

| Directory | Purpose |
|-----------|---------|
| `archetypes/` | Archetype configs |
| `generation/` | Trajectory generation |
| `training/` | Recording and export |
| `scoring/` | LLM-as-judge |
| `rubrics/` | Evaluation rubrics |
| `benchmark/` | Model benchmarking |
| `huggingface/` | HuggingFace upload |

### Python (`python/src/`)

| Directory | Purpose |
|-----------|---------|
| `data_bridge/` | Database reader |
| `training/` | Training modules |

## Environment Variables

```bash
# Required
DATABASE_URL=postgresql://...       # PostgreSQL connection
OPENAI_API_KEY=sk-...               # For RLAIF judge

# Optional
WANDB_API_KEY=your_key              # For W&B logging (offline if not set)
TINKER_API_KEY=your_key             # For cloud training
```

## Troubleshooting

**No trajectory data**
```bash
bun run dev
babylon train parallel --archetypes trader --num-agents 5 --ticks 20
```

**Not enough samples** - Need 20+ trajectories with LLM calls. Run more agents.

**MLX fails** - `pip install mlx mlx-lm`

**CUDA OOM** - Use smaller model or add `--lora`

**Database issues** - Check `DATABASE_URL` in `.env`, ensure PostgreSQL running

**vLLM startup timeout** - Increase timeout or check GPU memory with `nvidia-smi`

**W&B offline mode** - If you see "offline mode", set `WANDB_API_KEY` or use `--no-wandb`

## Scripts Reference

The `scripts/` directory contains standalone utilities for training operations:

| Script | Description |
|--------|-------------|
| `train-and-test.ts` | Full pipeline: train model + game test |
| `run-full-pipeline.ts` | Complete training workflow orchestration |
| `run-baseline-comparison.ts` | Head-to-head benchmark: random vs trained |
| `real-archetype-benchmark.ts` | Benchmark using real agent data |
| `json-mode-benchmark.ts` | Benchmark without database dependency |
| `test-model-in-game.ts` | Test trained model in simulation |
| `test-trained-model.ts` | Validate trained model from DB or path |
| `test-scoring.ts` | Debug LLM-as-judge scoring |
| `e2e-training-test.ts` | End-to-end pipeline verification |
| `assess-training-data.ts` | Analyze training data quality |
| `export-rubrics.ts` | Export rubrics to JSON |
| `generate-research-report.ts` | Generate research documentation |
| `verify-final.ts` | Post-training verification checks |

Run any script with:

```bash
bun packages/training/scripts/<script-name>.ts [options]
```

## Development

```bash
bun test packages/training
bun run typecheck
bun run packages/training/scripts/e2e-training-test.ts  # E2E validation
```

### Python Tests

```bash
cd packages/training/python
source venv/bin/activate
pytest tests/ -v
```
