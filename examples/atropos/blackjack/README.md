# ElizaOS Atropos - Blackjack Environment

A Blackjack environment for training ElizaOS agents using the Atropos RL framework.
Integrates with OpenAI Gymnasium's Blackjack environment.

## Overview

This environment wraps the Gymnasium Blackjack environment, allowing ElizaOS agents
to learn optimal blackjack strategy through reinforcement learning.

## Installation

```bash
# From the repository root
pip install -e examples/atropos/blackjack
```

## Quick Start

```bash
# Watch AI play automatically
python -m elizaos_atropos_blackjack --mode auto

# Interactive mode
python -m elizaos_atropos_blackjack --mode interactive

# Run benchmark
python -m elizaos_atropos_blackjack --mode benchmark
```

## Environment Details

### State Space
- **Player Sum**: Current sum of player's cards (4-21)
- **Dealer Card**: Dealer's visible card (1-10)
- **Usable Ace**: Whether player has a usable ace (True/False)

### Action Space
- `0` - **Stick**: Stop taking cards and compare with dealer
- `1` - **Hit**: Request another card

### Rewards
- `+1.0`: Win (player closer to 21 without busting)
- `+1.5`: Blackjack (natural 21 on initial deal)
- `-1.0`: Loss (bust or dealer closer to 21)
- `0.0`: Draw (push)

## Usage with ElizaOS

```python
from elizaos import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin
from elizaos_atropos_blackjack import BlackjackEnvironment, BlackjackAgent

# Create environment
env = BlackjackEnvironment()
await env.initialize()

# Create ElizaOS agent
runtime = AgentRuntime(plugins=[get_openai_plugin()])
await runtime.initialize()
agent = BlackjackAgent(runtime)

# Training loop
for episode in range(1000):
    state = await env.reset()
    done = False
    
    while not done:
        action = await agent.decide(state, env.get_available_actions())
        state, reward, done, info = await env.step(action)
    
    # Learn from episode
    agent.record_episode(reward)
```

## Atropos Integration

This environment is compatible with the Atropos RL framework for distributed
trajectory collection and model training:

```python
from atropos import AtroposClient
from elizaos_atropos_blackjack import BlackjackEnvironment

# Register environment with Atropos
client = AtroposClient()
client.register_environment(BlackjackEnvironment)

# Collect trajectories
trajectories = await client.collect_rollouts(num_episodes=100)
```

## Basic Strategy Reference

The optimal basic strategy for blackjack depends on the player's hand and dealer's up card:

| Player Hand | Dealer 2-6 | Dealer 7-A |
|-------------|------------|------------|
| Hard 4-11   | Hit        | Hit        |
| Hard 12-16  | Stand      | Hit        |
| Hard 17+    | Stand      | Stand      |
| Soft 13-17  | Hit        | Hit        |
| Soft 18+    | Stand      | Stand      |

## License

MIT License - Part of the ElizaOS project.
