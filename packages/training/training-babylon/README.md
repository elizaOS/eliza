> **EXPERIMENTAL — not the canonical RL path.** Canonical RL is TRL DPO → verl GRPO per `training/RL_STRATEGY.md`. This subtree uses mock trajectories and is research scaffold only. Do not promote it to the canonical pipeline, do not wire it into `serve_vllm.py` or `model_registry.py`, and do not consume its outputs as eliza-1 weights.

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

# Run the RL-only trainer directly
python scripts/run_training.py --steps 100

# Or use the canonical project pipeline from the CLI
cd /Users/shawwalters/babylon-workspace/babylon
babylon train pipeline --local-backend mlx --local-steps 100
```

## Canonical Scam-Defense Release

The canonical scam-defense dataset/model release is built from the selection file
at:

`/Users/shawwalters/babylon-workspace/Marketplace-of-Trust/runs/scam-defense/release_selection.json`

Use the consolidated builder:

```bash
cd /Users/shawwalters/babylon-workspace/babylon/packages/training/python/scripts
python3 build_scam_defense_release.py \
  --selection /Users/shawwalters/babylon-workspace/Marketplace-of-Trust/runs/scam-defense/release_selection.json \
  --output-dir /Users/shawwalters/babylon-workspace/babylon/releases/scam-defense-v1 \
  --clean
```

That produces a single bundle with:

- a Hugging Face-ready dataset repo
- Hugging Face-ready model repos for the selected checkpoints
- training/publish instructions
- copied publication artifacts

## Local GRPO Training

The local training pipeline uses the Atropos framework for GRPO-based RL training.

### Prerequisites

1. **Python 3.11+** with CUDA support
2. **PostgreSQL** with trajectory data
3. **GPU** with at least 12GB VRAM (for the 4B profile)

### Quick Run

```bash
cd packages/training/python
source venv/bin/activate

# RL-only runner
python scripts/run_training.py --steps 100

# Trust/scam-focused run
python scripts/run_training.py --steps 100 --reward-profile trust_blue

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
| `--model` | Base model | `Qwen/Qwen3.5-4B` |
| `--save-path` | Checkpoint directory | `./trained_models` |
| `--save-every` | Save checkpoint every N steps | `5` |
| `--resume` | Resume from checkpoint path | - |
| `--reward-profile` | Reward profile from `packages/training/config/reward_weights.yaml` | `default` |

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
| `train/social_reward_mean` | Average social reward (for non-trading archetypes) |
| `train/counterfactual_alpha_mean` | Skill signal (with causal scenarios) |

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
| Mac M1/M2 (16GB) | MLX | `mlx-community/Qwen3.5-4B-MLX-4bit` | 8GB |
| Mac M1/M2 (32GB+) | MLX | `mlx-community/Qwen3.5-4B-MLX-4bit` | 16GB |
| GTX 3060+ (12GB) | CUDA | `Qwen/Qwen3.5-4B` | 12GB |
| GTX 4090 (24GB) | CUDA | `Qwen/Qwen3.5-9B` | 20GB |
| Any | Tinker | Cloud-based | N/A |

Local backend defaults can be overridden with:
- `BABYLON_LOCAL_MLX_MODEL`
- `BABYLON_LOCAL_CUDA_MODEL`
- `BABYLON_LOCAL_CPU_MODEL`

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
babylon train pipeline -a trader              # Canonical pipeline
babylon train run -a all                      # All archetypes
```

## Benchmarking

Evaluate trained models against fixed scenarios and baselines.

### Quick Start

```bash
# Run full benchmark suite (all 4 scenarios)
bun run benchmark

# Quick mode (7-day scenarios instead of 22-day)
bun run benchmark:quick

# Specific scenario
bun run benchmark -- --scenario bear-market

# With trained model
bun run benchmark -- --model ./trained_models/step_100
```

### Fixed Scenarios

| Scenario | Description | Tests |
|----------|-------------|-------|
| `bull-market` | 22-day steady uptrend | Basic competence, trend following |
| `bear-market` | 40% crash at day 10, recovery | Capital protection, risk management |
| `scandal-unfolds` | Hidden scandal revealed through leaks | Information processing, early warning detection |
| `pump-and-dump` | Coordinated market manipulation | Skepticism, avoiding FOMO |

### CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `--scenario <id>` | Run specific scenario | all |
| `--model <path>` | Path to trained model | momentum strategy |
| `--baseline <type>` | Baseline strategy: `random`, `momentum` | `random` |
| `--archetype <type>` | Archetype to test | `trader` |
| `--quick` | Quick mode (shorter scenarios) | `false` |
| `--output <dir>` | Output directory for reports | auto-generated |
| `--json` | Output JSON only (no HTML) | `false` |

### Output Reports

The benchmark suite generates:

1. **HTML Report** - Stakeholder-friendly visualization with charts
2. **JSON Report** - Machine-readable data for dashboards
3. **Text Summary** - Terminal-friendly output

Reports are saved to `benchmark-results/<timestamp>/`.

### Regenerate Scenarios

If you need to regenerate the fixed benchmark scenarios:

```bash
bun run benchmark:scenarios
```

### CI Integration

Benchmarks run automatically via GitHub Actions:
- After training workflow completes
- Nightly at 3 AM UTC
- Manual dispatch from Actions tab

---

## Python Training

### Qwen Capacity Planning

Plan the hardware and context envelope before changing the scam-defense recipe:

```bash
cd /Users/shawwalters/babylon-workspace/babylon/packages/training
make qwen-capacity MODEL=9b CONTEXTS=128k,256k TRAINING_SEQ_LENGTH=8192
```

The detailed planner notes live in:

- `/Users/shawwalters/babylon-workspace/babylon/packages/training/QWEN_CAPACITY_RUNBOOK.md`

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
  --backend cuda \
  --model Qwen/Qwen3.5-4B \
  --source-dir /path/to/export \
  --output ./trained_models/qwen35-4b-qlora \
  --optimizer adamw \
  --quantization nf4 \
  --lora \
  --lora-rank 32 \
  --lora-alpha 64 \
  --gradient-accumulation-steps 4 \
  --max-seq-length 4096 \
  --validate
```

For full-parameter APOLLO on a CUDA machine:

```bash
python scripts/train_local.py \
  --backend cuda \
  --model Qwen/Qwen3.5-9B \
  --source-dir /path/to/export \
  --output ./trained_models/qwen35-9b-apollo \
  --optimizer apollo \
  --no-lora \
  --apollo-rank 64 \
  --apollo-scale 1.0 \
  --apollo-update-proj-gap 200 \
  --max-seq-length 1024 \
  --validate
```

### Cloud Training (Tinker)

```bash
export TINKER_API_KEY=your_key

# Option 1: load trajectories directly from Postgres
export DATABASE_URL=postgresql://...

# Option 2: use an exported Hugging Face dataset on remote machines
export TRAJECTORY_SOURCE=huggingface
export HF_TRAJECTORY_DATASET=your-org/scambench-trajectories
export HF_TRAJECTORY_SPLIT=raw

python scripts/run_pipeline.py \
  --training-backend tinker \
  --tinker-steps 500 \
  --rl-steps 100
```

For the canonical local SFT path through the same orchestrator:

```bash
python scripts/run_pipeline.py \
  --mode train \
  --training-backend local \
  --local-backend cuda \
  --local-model Qwen/Qwen3.5-4B \
  --local-quantization nf4 \
  --local-lora \
  --local-lora-rank 32 \
  --local-max-seq-length 4096 \
  --local-gradient-accumulation-steps 4 \
  --local-steps 100
```

Notes:
- `run_pipeline.py` is the canonical entrypoint. It trains Tinker on the same curated/scored trajectory groups the local pipeline uses.
- The repo does not currently ship a public ScamBench trajectory dataset id. If you use `TRAJECTORY_SOURCE=huggingface`, export and push your own dataset first.
- Tinker runs now record remote sampler checkpoint refs, a resumable `remote_state_ref`, and a downloaded checkpoint archive in `training_manifest.json`.
- Full canonical Tinker runs now continue from the SFT state into a Tinker-native RL stage instead of forcing `--skip-rl`.
- Served eval and ScamBench run against Tinker's OpenAI-compatible inference endpoint using the initial sampler checkpoint vs the final sampler checkpoint from the run.
- `python scripts/run_tinker_training.py` remains available as a low-level standalone trainer, defaults to `Qwen/Qwen3.5-4B`, and normalizes stale dated Tinker model ids when the live catalog has moved forward.
- See [deploy/TINKER_RUNBOOK.md](/Users/shawwalters/babylon-workspace/babylon/packages/training/deploy/TINKER_RUNBOOK.md) for the recommended remote-machine workflow.
- `python scripts/test_pipeline.py --local-export-dir <export-dir>` runs the current preflight checks against the canonical pipeline, dependency audit, rollback tooling, Nebius dry-run, optional alert webhook ping, and optional throughput-report validation.
- Local smoke tests, dependency audits, rollback checks, and webhook alert tests are automated; live Tinker or Nebius runs plus target-H100/H200 throughput qualification are still separate production gates.

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
| `run_pipeline.py` | Canonical end-to-end project pipeline |
| `run_training.py` | RL-only trainer / low-level iteration path |

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
| `run-benchmark-suite.ts` | **Advanced benchmark suite** - compare models across scenarios |
| `generate-benchmark-scenarios.ts` | Regenerate fixed benchmark scenario files |
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
