# Environment Variables

All environment variables used by the training pipeline.

## Required Variables

### DATABASE_URL

PostgreSQL connection string.

```bash
export DATABASE_URL=postgresql://user:password@host:port/database
```

Examples:

```bash
# Local development
DATABASE_URL=postgresql://babylon:password@localhost:5432/babylon

# Test database
DATABASE_URL=postgresql://babylon_test:test_password@localhost:5434/babylon_test

# Cloud (staging)
DATABASE_URL=postgresql://user:secret@db.example.com:5432/babylon_staging
```

**When required**: Always for DB mode training. Not required for JSON mode.

## Optional Variables

### WANDB_API_KEY

Weights & Biases API key for experiment logging.

```bash
export WANDB_API_KEY=your_wandb_api_key
```

Get from: [wandb.ai](https://wandb.ai) → Settings → API Keys

**Effect**: Enables online experiment tracking. Without it, W&B runs in offline mode.

### WANDB_PROJECT

W&B project name.

```bash
export WANDB_PROJECT=babylon-training
```

Default: `babylon-training`

### WANDB_ENTITY

W&B team or username.

```bash
export WANDB_ENTITY=your-team
```

Default: Your personal W&B account.

### WANDB_MODE

Control W&B behavior.

```bash
export WANDB_MODE=offline    # Don't send to cloud
export WANDB_MODE=disabled   # Turn off completely
export WANDB_MODE=online     # Default - send to cloud
```

### OPENAI_API_KEY

OpenAI API key for LLM-as-judge.

```bash
export OPENAI_API_KEY=sk-your-key
```

**When required**: Only for LLM judge scoring (optional). Not required for Python judge.

### GROQ_API_KEY

Groq API key for data generation.

```bash
export GROQ_API_KEY=your_groq_key
```

**When required**: For `generate-training-data.ts` if using Groq as provider.

### ANTHROPIC_API_KEY

Anthropic API key for data generation.

```bash
export ANTHROPIC_API_KEY=your_anthropic_key
```

**When required**: For `generate-training-data.ts` if using Anthropic as provider.

## GPU Configuration

### CUDA_VISIBLE_DEVICES

Select which GPUs to use.

```bash
export CUDA_VISIBLE_DEVICES=0        # Use GPU 0 only
export CUDA_VISIBLE_DEVICES=0,1      # Use GPUs 0 and 1
export CUDA_VISIBLE_DEVICES=""       # Use CPU only
```

Default: All available GPUs.

### VLLM_STARTUP_TIMEOUT

Seconds to wait for vLLM server to start.

```bash
export VLLM_STARTUP_TIMEOUT=300
```

Default: 120 seconds.

Increase if vLLM takes longer to load large models.

## Training Configuration

### HYBRID_ONLINE_RATIO

Ratio of online vs offline data in hybrid mode.

```bash
export HYBRID_ONLINE_RATIO=0.2   # 20% online, 80% offline
```

Default: 0.2

### USE_SIMULATION_BRIDGE

Enable simulation bridge for online training.

```bash
export USE_SIMULATION_BRIDGE=1
```

Default: Disabled.

### SIMULATION_BRIDGE_URL

URL of the simulation bridge server.

```bash
export SIMULATION_BRIDGE_URL=http://localhost:3001
```

Default: `http://localhost:3001`

## Development Variables

### PYTHONPATH

Add source directories to Python path.

```bash
export PYTHONPATH=.
# or
export PYTHONPATH=/path/to/packages/training/python
```

Usually set automatically by Makefile targets.

### LOG_LEVEL

Control logging verbosity.

```bash
export LOG_LEVEL=DEBUG    # Most verbose
export LOG_LEVEL=INFO     # Normal
export LOG_LEVEL=WARNING  # Only warnings and errors
export LOG_LEVEL=ERROR    # Only errors
```

Default: INFO

## Configuration Files vs Environment

Some settings can be in config files or environment:

| Setting | Environment | Config File |
|---------|-------------|-------------|
| Database URL | `DATABASE_URL` | `babylon_atropos.yaml` |
| W&B Project | `WANDB_PROJECT` | `--wandb-project` CLI |
| GPU Memory | - | `profiles/*.json` |
| Model | - | `profiles/*.json` |

Environment variables take precedence over config files.

## Loading Variables

### From .env File

Create `.env` in project root:

```bash
# .env
DATABASE_URL=postgresql://babylon:password@localhost:5432/babylon
WANDB_API_KEY=your_key
OPENAI_API_KEY=sk-your-key
```

Python auto-loads via `dotenv`:

```python
from dotenv import load_dotenv
load_dotenv()  # Loads .env file
```

### For Single Command

```bash
DATABASE_URL=... WANDB_MODE=offline python scripts/run_training.py
```

### In Shell Session

```bash
export DATABASE_URL=postgresql://...
export WANDB_API_KEY=...

# Now all commands in this session have these vars
make train-12gb
```

## Security Notes

1. **Never commit `.env` files** - Add to `.gitignore`
2. **Use secrets managers** for production
3. **Rotate keys** if exposed
4. **Use read-only DB credentials** when possible

## Troubleshooting

### "DATABASE_URL not set"

```bash
export DATABASE_URL=postgresql://babylon:password@localhost:5432/babylon
```

### "W&B API key not configured"

```bash
export WANDB_API_KEY=your_key
# or disable W&B
python scripts/run_training.py --no-wandb
```

### "No API keys found" (data generation)

```bash
# Set at least one of:
export GROQ_API_KEY=your_key
export OPENAI_API_KEY=your_key
export ANTHROPIC_API_KEY=your_key
```

## Complete Example

```bash
# ~/.bashrc or ~/.zshrc

# Required
export DATABASE_URL=postgresql://babylon:password@localhost:5432/babylon

# Optional but recommended
export WANDB_API_KEY=your_wandb_key
export OPENAI_API_KEY=sk-your-openai-key
export GROQ_API_KEY=your_groq_key

# GPU selection (if multiple GPUs)
export CUDA_VISIBLE_DEVICES=0

# Convenience
export PYTHONPATH=/path/to/packages/training/python
```

