# ElizaOS Atropos Environments

This directory contains ElizaOS integrations with the [Atropos](https://github.com/NousResearch/atropos) reinforcement learning framework by Nous Research.

## Overview

Atropos is a scalable RL framework for training large language models. These environments allow ElizaOS agents to learn through interaction across diverse tasks.

## Available Environments

| Environment | Description | Type | Complexity |
|-------------|-------------|------|------------|
| [Blackjack](./blackjack/) | Gymnasium Blackjack environment | Single-agent | Low |
| [Diplomacy](./diplomacy/) | Multi-agent negotiation game | Multi-agent | High |
| [TextWorld](./textworld/) | Text-based adventure games | Single-agent | Medium |
| [Hold'em](./holdem/) | Texas Hold'em poker | Multi-agent | Medium |
| [Reasoning](./reasoning/) | Math, logic, and puzzles | Single-agent | Variable |

## Installation

Each environment is a separate Python package that can be installed independently:

```bash
# Install all environments
pip install -e examples/atropos/blackjack
pip install -e examples/atropos/diplomacy
pip install -e examples/atropos/textworld
pip install -e examples/atropos/holdem
pip install -e examples/atropos/reasoning

# Or install a specific environment
pip install -e examples/atropos/blackjack
```

## Quick Start

### Blackjack
```bash
python -m elizaos_atropos_blackjack --mode auto
```

### Diplomacy
```bash
python -m elizaos_atropos_diplomacy --mode auto
```

### TextWorld
```bash
python -m elizaos_atropos_textworld --mode auto
```

### Poker Hold'em
```bash
python -m elizaos_atropos_holdem --mode auto
```

### Reasoning Gym
```bash
python -m elizaos_atropos_reasoning --mode eval --task math
```

## Using with ElizaOS Agents

All environments follow a consistent pattern for integration with ElizaOS:

```python
from elizaos import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin

# Create an ElizaOS runtime
runtime = AgentRuntime(plugins=[get_openai_plugin()])
await runtime.initialize()

# Import and use any environment
from elizaos_atropos_blackjack import BlackjackEnvironment, BlackjackAgent

env = BlackjackEnvironment()
await env.initialize()

agent = BlackjackAgent(runtime, use_llm=True)

# Training loop
state = await env.reset()
while not state.done:
    action = await agent.decide(state, env.get_available_actions())
    state = await env.step(action)
```

## Atropos Integration

These environments can be registered with Atropos for distributed trajectory collection:

```python
from atropos import AtroposClient

# Register environment
client = AtroposClient()
client.register_environment(BlackjackEnvironment)

# Collect trajectories
trajectories = await client.collect_rollouts(num_episodes=1000)
```

## Environment Details

### Blackjack 🃏
- **Based on**: Gymnasium Blackjack-v1
- **Goal**: Beat the dealer without exceeding 21
- **Actions**: Hit, Stand
- **Features**: Basic strategy implementation, LLM decision making

### Diplomacy 🌍
- **Based on**: Classic Diplomacy board game
- **Goal**: Control 18 supply centers
- **Players**: 7 (Austria, England, France, Germany, Italy, Russia, Turkey)
- **Features**: Multi-agent, negotiation support (press mode)

### TextWorld 📖
- **Based on**: Microsoft TextWorld framework
- **Goal**: Complete text adventure objectives
- **Actions**: Natural language commands
- **Features**: Procedural game generation, multiple difficulty levels

### Hold'em 🎰
- **Based on**: No-Limit Texas Hold'em rules
- **Goal**: Win chips from opponents
- **Players**: 2-9
- **Features**: Hand evaluation, tournament mode, position-aware strategy

### Reasoning 🧠
- **Based on**: Reasoning Gym concept
- **Goal**: Solve reasoning problems
- **Tasks**: Math, Logic, Puzzles, Commonsense
- **Features**: Chain-of-thought prompting, hint system, progressive difficulty

## Architecture

Each environment follows a consistent structure:

```
environment_name/
├── README.md                    # Documentation
├── pyproject.toml               # Package configuration
└── elizaos_atropos_{name}/
    ├── __init__.py              # Package exports
    ├── types.py                 # Type definitions
    ├── environment.py           # Main environment class
    ├── agent.py                 # ElizaOS agent integration
    └── cli.py                   # Command-line interface
```

## Requirements

- Python 3.11+
- elizaos>=1.0.0
- Optional: elizaos-plugin-openai for LLM-based agents

## License

MIT License - Part of the ElizaOS project.

## References

- [Atropos Framework](https://github.com/NousResearch/atropos)
- [Nous Research](https://nousresearch.com/)
- [ElizaOS](https://elizaos.ai/)
