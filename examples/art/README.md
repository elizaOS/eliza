# ElizaOS ART (Adaptive Reinforcement Training) Demos

Continuous reinforcement learning system for training local LLMs to play games and solve puzzles using OpenPipe's ART framework with GRPO (Group Relative Policy Optimization).

## Overview

This package provides complete training pipelines for:
- **2048** - Tile-merging puzzle game
- **Tic-Tac-Toe** - Classic strategy game
- **Codenames** - Word association game (spymaster/guesser roles)
- **Temporal Clue** - Logic puzzle requiring temporal reasoning

## Key Features

- **GRPO Training**: Group Relative Policy Optimization for efficient RL training
- **RULER Scoring**: LLM-as-judge for automatic trajectory ranking
- **Local Models**: Optimized for Llama 3.2 1B/3B Instruct
- **Checkpointing**: Resume training from any point
- **Benchmarking**: Compare vanilla vs trained models
- **Pipeline Mode**: Run full train → evaluate → compare workflows

## Supported Models

| Model | Parameters | Use Case |
|-------|------------|----------|
| `meta-llama/Llama-3.2-1B-Instruct` | 1B | Fast iteration, testing |
| `meta-llama/Llama-3.2-3B-Instruct` | 3B | Production training |

## Installation

```bash
cd examples/art
pip install -e ".[dev,local]"
```

### For local model training (optional):
```bash
pip install -e ".[local]"  # Adds vLLM support
```

## Quick Start

### Run a single game with vanilla model:
```bash
elizaos-art-2048 play --episodes 10
```

### Benchmark vanilla vs trained:
```bash
elizaos-art-2048 benchmark --episodes 100
```

### Full training pipeline:
```bash
elizaos-art-2048 pipeline --steps 50 --rollouts 8
```

## Training Pipeline

The training pipeline follows these stages:

1. **Baseline**: Run vanilla model to establish baseline metrics
2. **Rollout**: Generate trajectory groups from current model
3. **RULER Score**: Use LLM judge to rank trajectories
4. **GRPO Train**: Update model weights based on rankings
5. **Checkpoint**: Save model state
6. **Evaluate**: Test trained model
7. **Compare**: Generate comparison report

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Rollout   │───▶│   RULER     │───▶│    GRPO    │
│ Trajectories│    │   Score     │    │   Train    │
└─────────────┘    └─────────────┘    └─────────────┘
       │                                      │
       │                                      ▼
       │                              ┌─────────────┐
       │                              │ Checkpoint  │
       │                              └─────────────┘
       │                                      │
       ▼                                      ▼
┌─────────────┐                       ┌─────────────┐
│  Baseline   │◀──────────────────────│  Evaluate   │
│  Metrics    │                       │   Model     │
└─────────────┘                       └─────────────┘
```

## CLI Commands

### Global Commands

```bash
# List all games
elizaos-art list

# Run benchmarks across all games
elizaos-art benchmark-all --episodes 50

# Show training status
elizaos-art status
```

### Per-Game Commands

Each game supports these commands:

```bash
# Play mode - watch the agent play
elizaos-art-{game} play [--episodes N] [--model MODEL]

# Interactive mode - play yourself with AI hints  
elizaos-art-{game} interactive

# Benchmark mode - compare strategies/models
elizaos-art-{game} benchmark [--episodes N] [--models MODEL1,MODEL2]

# Train mode - run GRPO training
elizaos-art-{game} train [--steps N] [--rollouts N] [--lr RATE]

# Pipeline mode - full train + evaluate
elizaos-art-{game} pipeline [--steps N] [--resume]

# Evaluate a checkpoint
elizaos-art-{game} evaluate --checkpoint PATH
```

## Configuration

### Environment Variables

```bash
# Required for RULER judge
export OPENAI_API_KEY="sk-..."       # For OpenAI judge
export ANTHROPIC_API_KEY="sk-..."    # For Claude judge

# For local models
export HF_TOKEN="hf_..."             # HuggingFace token for Llama

# Training config (optional)
export ART_LEARNING_RATE="1e-5"
export ART_ROLLOUTS_PER_GROUP="8"
export ART_GROUPS_PER_STEP="4"
export ART_MAX_STEPS="100"
```

### Config File

Create `art_config.yaml` in your working directory:

```yaml
model:
  name: "meta-llama/Llama-3.2-3B-Instruct"
  backend: "vllm"  # or "huggingface"

training:
  learning_rate: 1e-5
  rollouts_per_group: 8
  groups_per_step: 4
  max_steps: 100

ruler:
  judge_model: "openai/gpt-5-mini"  # or "anthropic/claude-3-haiku"
  temperature: 0.0

checkpoints:
  dir: "./checkpoints"
  save_every: 5
```

## Game Details

### 2048

Train an agent to achieve high scores in the 2048 tile-merging game.

**State**: 4x4 grid of tile values (powers of 2)
**Actions**: UP, DOWN, LEFT, RIGHT
**Reward**: Score achieved (sum of merged tiles)

```bash
elizaos-art-2048 pipeline --steps 100 --target-score 2048
```

### Tic-Tac-Toe

Train an agent to play optimal Tic-Tac-Toe.

**State**: 3x3 board with X, O, or empty
**Actions**: Place mark at position (0-8)
**Reward**: +1 win, 0 draw, -1 loss

```bash
elizaos-art-tictactoe pipeline --steps 50 --opponent random
```

### Codenames

Train agents for both Spymaster and Guesser roles.

**Spymaster State**: Full board + team assignments
**Spymaster Actions**: Give clue (word, number)
**Guesser State**: Board + clue
**Guesser Actions**: Select word(s)
**Reward**: +1 correct guess, -1 wrong team, -3 assassin

```bash
elizaos-art-codenames pipeline --role spymaster --steps 100
```

### Temporal Clue

Train an agent to solve logic puzzles requiring temporal reasoning.

**State**: Clues about events and their temporal relationships
**Actions**: Deduce event ordering
**Reward**: Binary (correct/incorrect solution)

```bash
elizaos-art-temporal pipeline --difficulty medium --steps 75
```

## Output Structure

```
checkpoints/
├── 2048/
│   ├── step_0/              # Baseline model
│   ├── step_10/
│   ├── step_20/
│   └── final/
├── tic_tac_toe/
├── codenames/
└── temporal_clue/

results/
├── 2048/
│   ├── baseline_metrics.json
│   ├── training_log.jsonl
│   ├── trajectories/
│   │   ├── step_0.jsonl
│   │   ├── step_10.jsonl
│   │   └── ...
│   └── benchmark_report.md
└── ...
```

## Benchmarking Results

After training, generate a comparison report:

```bash
elizaos-art-2048 report --output benchmark_report.md
```

Example output:

```markdown
## 2048 Training Results

| Metric | Vanilla | Trained | Improvement |
|--------|---------|---------|-------------|
| Avg Score | 1,234 | 4,567 | +270% |
| Max Tile | 256 | 1024 | +4x |
| Win Rate | 0% | 23% | +23% |

### Training Progress
- Steps: 100
- Trajectories: 800
- Training Time: 4.2 hours
```

## API Usage

```python
import asyncio
from elizaos_art.games.game_2048 import Game2048Environment, Game2048Agent
from elizaos_art.trainer import GRPOTrainer

async def main():
    # Create environment and agent
    env = Game2048Environment()
    agent = Game2048Agent(model="meta-llama/Llama-3.2-3B-Instruct")
    
    # Create trainer
    trainer = GRPOTrainer(
        env=env,
        agent=agent,
        learning_rate=1e-5,
        rollouts_per_group=8,
    )
    
    # Train
    await trainer.train(num_steps=100)
    
    # Evaluate
    results = await trainer.evaluate(num_episodes=100)
    print(f"Trained model avg score: {results.avg_score}")

asyncio.run(main())
```

## ElizaOS Integration

This package integrates seamlessly with ElizaOS plugins for production use:

### plugin-trajectory-logger

Captures complete trajectories including:
- LLM calls (prompts, responses, latency)
- Environment states
- Actions and rewards
- Export to HuggingFace and OpenPipe ART format

```python
from elizaos_art.eliza_integration import ElizaTrajectoryLogger

logger = ElizaTrajectoryLogger(agent_id="my-agent")
traj_id = logger.start_trajectory(scenario_id="game-1")

# ... run episode with logging ...

logger.end_trajectory(traj_id, status="completed")
```

### plugin-local-ai

Run local GGUF models for inference:

```python
from elizaos_art.eliza_integration import ElizaLocalAIProvider, LocalModelConfig

config = LocalModelConfig(
    small_model="Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    gpu_layers=43,
)
provider = ElizaLocalAIProvider(config)
await provider.initialize()

response = await provider.generate_text(
    prompt="What is the best move?",
    system_prompt="You are a game-playing agent.",
)
```

### plugin-localdb

Store trajectories and checkpoints:

```python
from elizaos_art.eliza_integration import ElizaStorageAdapter

storage = ElizaStorageAdapter(data_dir="./data")

# Save trajectory
await storage.save_trajectory(trajectory)

# Search by scenario
trajectories = await storage.get_trajectories_by_scenario("game-1")
```

### Unified Runtime

Use `ARTRuntime` for fully integrated training:

```python
from elizaos_art.eliza_integration import create_art_runtime, ARTRuntimeConfig
from elizaos_art.games.game_2048 import Game2048Environment, Game2048Agent

runtime = create_art_runtime(
    env=Game2048Environment(),
    agent=Game2048Agent(),
    config=ARTRuntimeConfig(
        agent_id="2048-trainer",
        use_mock_model=False,  # Use real local model
    ),
)

await runtime.initialize()

# Run evaluation
results = await runtime.evaluate(num_episodes=100)
print(f"Win rate: {results['win_rate']:.1%}")

# Generate training trajectories
trajectories = await runtime.rollout_batch(
    scenario_id="training-batch-1",
    num_rollouts=8,
)
```

## References

- [OpenPipe ART Documentation](https://art.openpipe.ai)
- [GRPO Paper](https://arxiv.org/abs/2402.03300)
- [Llama 3.2 Models](https://huggingface.co/meta-llama)
- [ElizaOS Documentation](https://elizaos.ai)
