# elizaOS Atropos - TextWorld Environment

A TextWorld environment for training elizaOS agents using the Atropos RL framework.
Integrates with Microsoft's TextWorld framework for procedurally generated text adventure games.

## Overview

TextWorld is a sandbox learning environment for training agents to play text-based games.
This integration allows elizaOS agents to:
- Learn language understanding through interactive fiction
- Develop planning and reasoning capabilities
- Practice multi-step problem solving
- Build generalizable language skills

## Installation

```bash
# From the repository root
pip install -e examples/atropos/textworld

# With Atropos support (for training data generation)
pip install -e "examples/atropos/textworld[atropos]"

# With OpenAI support (for elizaOS agent)
pip install -e "examples/atropos/textworld[openai]"
```

## Quick Start

```bash
# Watch AI play a simple game
python -m elizaos_atropos_textworld --mode auto

# Interactive mode (play yourself)
python -m elizaos_atropos_textworld --mode interactive

# Custom difficulty
python -m elizaos_atropos_textworld --mode auto --difficulty hard

# Run benchmark comparing heuristic vs random
python -m elizaos_atropos_textworld --mode benchmark --episodes 100

# Generate Atropos training data
python -m elizaos_atropos_textworld --mode atropos-gen --episodes 100 -o trajectories.jsonl
```

## Environment Details

### Game Types
- **Treasure Hunt**: Find and collect items
- **Cooking**: Follow recipes and cook meals
- **Coin Collector**: Navigate and collect coins
- **Simple**: Basic navigation and object interaction

### Observation Space
- **Description**: Current room description
- **Inventory**: Items the player is carrying
- **Admissible Commands**: Valid actions in current state

### Action Space
Text commands such as:
- Navigation: `go north`, `go east`, `go south`, `go west`
- Interaction: `take <item>`, `drop <item>`, `open <container>`
- Examination: `look`, `examine <object>`, `inventory`
- Cooking: `cook <item> with <appliance>`, `eat <item>`

### Rewards
- `+1`: Completing sub-goals (finding items, opening doors)
- `+10`: Completing the main objective
- `-0.1`: Invalid commands
- `0`: Neutral actions

## Usage with elizaOS

### Using the Full elizaOS Agent

```python
from elizaos_atropos_textworld import TextWorldEnvironment, ElizaOSAgent

# Create environment
env = TextWorldEnvironment(game_type="treasure_hunt", difficulty="medium")
await env.initialize()

# Create elizaOS agent (uses OpenAI plugin internally)
agent = ElizaOSAgent()
await agent.initialize()

# Game loop
state = await env.reset()

while not state.game_over:
    # Agent decides action using LLM
    action = await agent.decide(state)
    
    # Execute action
    result = await env.step(action)
    state = result.state
    
    print(f"Action: {action} | Score: {state.score}/{state.max_score}")

print(f"Game completed! Won: {state.won}")

# Cleanup
await agent.cleanup()
await env.close()
```

### Using the Heuristic Agent (No LLM)

```python
from elizaos_atropos_textworld import TextWorldEnvironment, create_heuristic_policy

env = TextWorldEnvironment(game_type="treasure_hunt", difficulty="medium")
await env.initialize()

# Play a full episode with heuristics
result = await env.play_episode(create_heuristic_policy)
print(f"Score: {result.score}/{result.max_score} | Won: {result.won}")
```

### Using Custom Runtime

```python
from elizaos import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin
from elizaos_atropos_textworld import TextWorldEnvironment, TextWorldAgent

# Create environment
env = TextWorldEnvironment(game_type="treasure_hunt", difficulty="medium")
await env.initialize()

# Create custom elizaOS runtime
runtime = AgentRuntime(plugins=[get_openai_plugin()])
await runtime.initialize()

# Use TextWorldAgent with custom runtime
agent = TextWorldAgent(runtime=runtime, use_llm=True)

state = await env.reset()
while not state.game_over:
    action = await agent.decide(state)
    result = await env.step(action)
    state = result.state

await runtime.stop()
await env.close()
```

## Atropos Integration

The TextWorld environment supports the Atropos RL framework for trajectory collection
and model training. This enables GRPO (Group Relative Policy Optimization) training
on text adventure gameplay.

### Generating Training Data (CLI)

```bash
# Generate training data with elizaOS agent
python -m elizaos_atropos_textworld --mode atropos-gen --episodes 500 -o train.jsonl

# Generate baseline with heuristic agent (no LLM calls)
python -m elizaos_atropos_textworld --mode atropos-gen --episodes 500 --no-use-elizaos -o baseline.jsonl

# Specify tokenizer (default: meta-llama/Llama-3.2-3B-Instruct)
python -m elizaos_atropos_textworld --mode atropos-gen --episodes 100 --tokenizer gpt2 -o test.jsonl
```

### Generating Training Data (Python API)

```python
from elizaos_atropos_textworld.atropos_integration import (
    generate_training_data,
    AtroposConfig,
)

# Configure generation
config = AtroposConfig(
    tokenizer_name="meta-llama/Llama-3.2-3B-Instruct",
    game_type="treasure_hunt",
    difficulty="medium",
    max_tokens=4096,
    use_elizaos=True,  # Use elizaOS agent (requires OPENAI_API_KEY)
    win_bonus=0.3,     # Bonus for winning
    efficiency_weight=0.2,  # Reward for efficient play
)

# Generate trajectories
trajectories = await generate_training_data(
    num_episodes=500,
    config=config,
    output_path="train.jsonl",
    verbose=True,
)
```

### Output Format

Each trajectory is a JSON object compatible with Atropos `ScoredDataItem`:

```json
{
  "tokens": [1, 2, 3, ...],
  "masks": [0, 0, 1, 1, ...],
  "scores": 0.85,
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "take key"}
  ],
  "overrides": {
    "agent": "elizaos",
    "seed": 42,
    "won": true
  }
}
```

- **tokens**: Tokenized conversation
- **masks**: Binary mask (1 = assistant tokens for training, 0 = context)
- **scores**: GRPO score (0.0 - 1.0)
- **messages**: Original conversation for debugging

### Live Training with BaseEnv

For live training integration with Atropos:

```python
from elizaos_atropos_textworld.atropos_integration import create_atropos_env_class

# Create and run as Atropos server
EnvClass = create_atropos_env_class()
EnvClass.cli()
```

## Game Examples

### Treasure Hunt
```
You are in a kitchen. There's a refrigerator here.
A table is in the center of the room.
You can see a knife on the table.

> take knife
You pick up the knife.

> open refrigerator
You open the refrigerator, revealing an apple.

> take apple
You pick up the apple.
*** You have won! ***
```

### Cooking Game
```
You're in a kitchen with a stove and counter.
There's a recipe book on the counter.

> read recipe book
Recipe: Grilled Cheese
- 2 slices of bread
- 1 slice of cheese
Grill with the stove.

> take bread
You take the bread.
...
```

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `game_type` | `treasure_hunt` | Type of game to generate |
| `difficulty` | `medium` | Game difficulty (easy/medium/hard) |
| `max_steps` | `100` | Maximum steps per episode |
| `seed` | `None` | Random seed for reproducibility |

## Architecture

```
elizaos_atropos_textworld/
├── __init__.py              # Package exports
├── types.py                 # Game types (GameState, Turn, Trajectory, etc.)
├── environment.py           # TextWorldEnvironment class
├── game_generator.py        # Procedural game generation
├── agent.py                 # elizaOS agent (ElizaOSAgent, TextWorldAgent)
├── atropos_integration.py   # Atropos RL integration
├── parser.py                # Natural language parser
└── cli.py                   # Command-line interface
```

### Atropos Integration Module

The `atropos_integration.py` module provides:

- **AtroposConfig**: Configuration for training data generation
- **TrajectoryCollector**: Records gameplay as turn-by-turn trajectories
- **AtroposFormatter**: Tokenizes trajectories with proper mask boundaries
- **generate_training_data()**: Async function to generate training data
- **create_atropos_env_class()**: Factory for Atropos BaseEnv (live training)

## Design Decisions

### Why Text Adventure Games for RL?

Text adventures are ideal for language model RL because:

1. **Pure language interface**: Input and output are both text - perfect for LLMs
2. **Clear reward signal**: Win/lose, score progression - easy to measure
3. **Multi-step reasoning**: Can't win in one move - requires planning
4. **Procedural generation**: Infinite game variety from TextWorld
5. **Interpretable**: Human-readable actions and observations

### Why GRPO (Group Relative Policy Optimization)?

GRPO compares multiple solutions to the SAME problem, computing which is relatively
better. This is more stable than absolute rewards because:

- Rewards are often noisy or poorly calibrated
- Relative comparison ("A is better than B") is more informative than "A scores 0.7"
- GRPO naturally handles sparse rewards (win/lose) by comparing outcomes

### Why Conversation Format for Trajectories?

We format gameplay as chat conversations (system/user/assistant) because:

1. **Transfer learning**: Pre-trained chat models already understand this format
2. **Standard tooling**: Chat tokenizers, training scripts all expect this format
3. **Natural mapping**: Game description → user message, action → assistant message

### Why Incremental Tokenization?

The naive approach (tokenize everything, find substrings for masks) is **broken**.
Tokenization is context-dependent - the same word tokenizes differently based on
preceding text. We use incremental tokenization to track exact message boundaries:

1. Tokenize messages [0..n-1]
2. Tokenize messages [0..n]
3. The difference is exactly message n's tokens

This is O(n²) but n (number of turns) is small (~100 max).

### Why Separate Offline and Live Training?

We support two modes:

- **Offline**: `generate_training_data()` - Generate JSONL, train later
- **Live**: `create_atropos_env_class()` - Atropos generates data during training

Offline is better for debugging, reproducibility, and sharing datasets.
Live is better for interactive training and curriculum learning.

### Why Heuristic Fallback?

LLMs fail (rate limits, invalid outputs, network issues). Rather than crash or
produce invalid trajectories, we fall back to simple heuristics (take > open > go).
This keeps data generation running and produces valid (if suboptimal) trajectories.

## Difficulty Levels

### Easy
- Small maps (3-5 rooms)
- Few objects
- Simple objectives
- Explicit hints

### Medium
- Medium maps (5-10 rooms)
- Multiple objects
- Multi-step objectives
- Some exploration needed

### Hard
- Large maps (10+ rooms)
- Many objects and containers
- Complex multi-step objectives
- Puzzles and locked doors

## License

MIT License - Part of the elizaOS project.
