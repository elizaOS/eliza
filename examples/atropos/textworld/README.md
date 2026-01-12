# ElizaOS Atropos - TextWorld Environment

A TextWorld environment for training ElizaOS agents using the Atropos RL framework.
Integrates with Microsoft's TextWorld framework for procedurally generated text adventure games.

## Overview

TextWorld is a sandbox learning environment for training agents to play text-based games.
This integration allows ElizaOS agents to:
- Learn language understanding through interactive fiction
- Develop planning and reasoning capabilities
- Practice multi-step problem solving
- Build generalizable language skills

## Installation

```bash
# From the repository root
pip install -e examples/atropos/textworld
```

## Quick Start

```bash
# Watch AI play a simple game
python -m elizaos_atropos_textworld --mode auto

# Interactive mode
python -m elizaos_atropos_textworld --mode interactive

# Custom difficulty
python -m elizaos_atropos_textworld --mode auto --difficulty hard

# Run benchmark
python -m elizaos_atropos_textworld --mode benchmark
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

## Usage with ElizaOS

```python
from elizaos import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin
from elizaos_atropos_textworld import TextWorldEnvironment, TextWorldAgent

# Create environment
env = TextWorldEnvironment(game_type="treasure_hunt", difficulty="medium")
await env.initialize()

# Create ElizaOS agent
runtime = AgentRuntime(plugins=[get_openai_plugin()])
await runtime.initialize()
agent = TextWorldAgent(runtime)

# Game loop
state = await env.reset()
done = False

while not done:
    # Agent decides action based on observation
    action = await agent.decide(
        observation=state.description,
        inventory=state.inventory,
        admissible_commands=state.admissible_commands,
    )
    
    # Execute action
    state, reward, done, info = await env.step(action)
    
    if reward > 0:
        print(f"Reward: {reward}")

print(f"Game completed! Score: {state.score}/{state.max_score}")
```

## Atropos Integration

```python
from atropos import AtroposClient
from elizaos_atropos_textworld import TextWorldEnvironment

# Register with Atropos
client = AtroposClient()
client.register_environment(TextWorldEnvironment)

# Collect trajectories for training
trajectories = await client.collect_rollouts(
    num_games=1000,
    game_type="treasure_hunt",
    difficulty="medium",
)
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
├── __init__.py           # Package exports
├── types.py              # Game types (GameState, Action, etc.)
├── environment.py        # TextWorldEnvironment class
├── game_generator.py     # Procedural game generation
├── agent.py              # ElizaOS agent integration
├── parser.py             # Natural language parser
└── cli.py                # Command-line interface
```

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

MIT License - Part of the ElizaOS project.
