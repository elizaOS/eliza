# Weights & Biases Integration

Optional experiment tracking with Weights & Biases (W&B).

## Overview

W&B provides:
- Real-time training metrics visualization
- Experiment comparison
- Hyperparameter tracking
- Model artifact storage
- Team collaboration

## Setup

### 1. Create Account

Sign up at [wandb.ai](https://wandb.ai)

### 2. Get API Key

Settings → API Keys → Copy your key

### 3. Set Environment Variable

```bash
export WANDB_API_KEY=your_key_here
```

Or add to `.env`:

```text
WANDB_API_KEY=your_key_here
```

## Running with W&B

### Enable Logging

```bash
# W&B is enabled by default if API key is set
python scripts/run_training.py --profile 12gb

# Specify project
python scripts/run_training.py --profile 12gb \
  --wandb-project babylon-training

# Specify team and project
python scripts/run_training.py --profile 12gb \
  --wandb-project babylon-training \
  --wandb-entity your-team
```

### Disable Logging

```bash
# Disable W&B completely
python scripts/run_training.py --profile 12gb --no-wandb

# Or use offline mode
export WANDB_MODE=offline
python scripts/run_training.py --profile 12gb
```

## Logged Metrics

### Training Metrics

| Metric | Description | Good Values |
|--------|-------------|-------------|
| `train/loss` | GRPO policy gradient loss | Decreasing |
| `train/learning_rate` | Current LR | Per schedule |
| `train/grad_norm` | Gradient magnitude | 0.1 - 10 |
| `train/step` | Current step | Increasing |

### Score Metrics

| Metric | Description | Good Values |
|--------|-------------|-------------|
| `train/score_mean` | Average batch score | ~0.5 |
| `train/score_std` | Score standard deviation | > 0.1 |
| `train/score_min` | Minimum score in batch | - |
| `train/score_max` | Maximum score in batch | - |

### Component Scores

| Metric | Description |
|--------|-------------|
| `train/pnl_score` | Financial performance |
| `train/format_score` | Response format quality |
| `train/reasoning_score` | Reasoning quality |
| `train/behavior_bonus` | Archetype alignment |

### Social Metrics

For non-trading archetypes (Social Butterfly, Information Trader, etc.):

| Metric | Description |
|--------|-------------|
| `train/social_reward_mean` | Combined social reward |
| `train/social_engagement_mean` | Posts, comments, DMs activity |
| `train/social_spread_mean` | Content reach and reactions |
| `train/social_network_mean` | Connections and reputation |
| `train/social_narrative_mean` | Alignment with ground truth |

### Enhanced Reward Metrics

When training with causal scenarios (price context available):

| Metric | Description |
|--------|-------------|
| `train/regime_bull_pct` | % of trajectories in bull market |
| `train/regime_bear_pct` | % of trajectories in bear market |
| `train/regime_sideways_pct` | % of trajectories in sideways market |
| `train/counterfactual_alpha_mean` | Skill signal (actual vs expected) |
| `train/market_volatility_mean` | Average market volatility |

### GRPO-Specific

| Metric | Description |
|--------|-------------|
| `train/pos_logp` | Log prob for high-scoring completions |
| `train/neg_logp` | Log prob for low-scoring completions |
| `train/logp_delta` | pos_logp - neg_logp (should increase) |

## Dashboard

### Project View

Navigate to: `https://wandb.ai/your-team/babylon-training`

- **Runs table**: All training runs
- **Workspace**: Custom metric charts
- **Reports**: Shareable analysis

### Run View

Click on a run to see:
- **Overview**: Config, summary metrics
- **Charts**: Time series of all metrics
- **System**: GPU usage, memory
- **Files**: Saved artifacts
- **Logs**: Training output

## Comparing Runs

### In Dashboard

1. Select multiple runs in table
2. Click "Compare"
3. View overlaid charts

### Parallel Coordinates

Good for hyperparameter sweeps:
1. Go to Workspace
2. Add "Parallel Coordinates" panel
3. Select hyperparameters and metrics

## Sweeps (Hyperparameter Tuning)

### Define Sweep

```yaml
# sweep.yaml
program: python/scripts/run_training.py
method: bayes
metric:
  name: train/loss
  goal: minimize
parameters:
  lr:
    min: 1e-6
    max: 1e-4
    distribution: log_uniform
  batch_size:
    values: [1, 2, 4]
  warmup_steps:
    values: [5, 10, 20]
```

### Run Sweep

```bash
# Initialize sweep
wandb sweep sweep.yaml

# Run agent (on each GPU)
wandb agent your-team/babylon-training/sweep_id
```

## Artifacts

### Save Model Checkpoints

```python
# In training code
artifact = wandb.Artifact('model', type='model')
artifact.add_dir('./trained_models/final_model')
wandb.log_artifact(artifact)
```

### Download Artifacts

```python
# In evaluation code
run = wandb.init()
artifact = run.use_artifact('your-team/babylon-training/model:latest')
artifact_dir = artifact.download()
```

## Alerts

### Setup Alerts

In W&B dashboard:
1. Go to Settings → Alerts
2. Create alert, e.g., "Loss stopped decreasing"
3. Configure threshold and notification

### Types

| Alert Type | Use Case |
|------------|----------|
| Email | Async notification |
| Slack | Team alerts |
| Webhooks | Custom integrations |

## Offline Mode

When no internet:

```bash
export WANDB_MODE=offline
python scripts/run_training.py --profile 12gb
```

Later, sync to cloud:

```bash
wandb sync ./wandb/offline-run-*
```

## Common Issues

### "API key not found"

```text
wandb: ERROR api_key not configured
```

**Fix**: Set `WANDB_API_KEY` environment variable.

### Runs not appearing

```bash
# Check mode
echo $WANDB_MODE  # Should not be "offline" or "disabled"

# Force online
export WANDB_MODE=online
```

### Rate limiting

W&B has rate limits for free tier. If hitting limits:

```python
# Reduce logging frequency
if step % 10 == 0:  # Log every 10 steps
    wandb.log(metrics)
```

## Makefile Integration

```makefile
# Cloud training with W&B
train-cloud: db-up db-migrate
    @echo "Starting cloud training with W&B..."
    cd $(PYTHON_DIR) && DATABASE_URL=$(DB_URL) \
        $(PYTHON) scripts/run_training.py \
        --profile $(PROFILE) \
        --wandb-project $(WANDB_PROJECT) \
        $(if $(WANDB_ENTITY),--wandb-entity $(WANDB_ENTITY),)

# Default project
WANDB_PROJECT ?= babylon-training
WANDB_ENTITY ?=
```

Usage:

```bash
make train-cloud PROFILE=l40 WANDB_PROJECT=my-project
```

## Best Practices

1. **Name runs meaningfully**: `trader-lr1e5-batch4`
2. **Add tags**: `["production", "trader", "v2"]`
3. **Log config**: All hyperparameters
4. **Save artifacts**: Best model, final model
5. **Write notes**: What you're trying, results

