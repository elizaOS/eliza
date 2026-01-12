# ElizaOS Atropos - Diplomacy Environment

A multi-agent Diplomacy game environment for training ElizaOS agents using the Atropos RL framework.

## Overview

Diplomacy is a strategic board game set in pre-WWI Europe where seven players control
different nations (Austria, England, France, Germany, Italy, Russia, Turkey). Unlike
most games, there are no dice or chance elements - success depends entirely on
negotiation, alliance-building, and strategic movement.

This environment supports:
- **Multi-agent play**: 7 AI agents negotiate and compete
- **Negotiation phases**: Agents can send messages and propose deals
- **No-Press mode**: Pure strategic play without negotiation
- **Press mode**: Full negotiation capabilities

## Installation

```bash
# From the repository root
pip install -e examples/atropos/diplomacy
```

## Quick Start

```bash
# Watch AI play (no-press mode)
python -m elizaos_atropos_diplomacy --mode auto

# Interactive mode (play as one nation)
python -m elizaos_atropos_diplomacy --mode interactive --nation france

# Full press (with negotiations)
python -m elizaos_atropos_diplomacy --mode press
```

## Environment Details

### Powers (Nations)
- **Austria-Hungary** (AUS): Central position, must balance alliances
- **England** (ENG): Island nation, strong navy
- **France** (FRA): Strong starting position, two fronts
- **Germany** (GER): Central power, many neighbors
- **Italy** (ITA): Mediterranean power, flexible alliances
- **Russia** (RUS): Largest territory, stretched thin
- **Turkey** (TUR): Corner position, defensible

### Game Phases
1. **Spring Movement**: Move armies and fleets
2. **Spring Retreat**: Retreat dislodged units
3. **Fall Movement**: Second movement phase
4. **Fall Retreat**: Second retreat phase
5. **Winter Adjustment**: Build/disband units

### Actions
- **HOLD**: Unit stays in place
- **MOVE**: Unit attempts to move to adjacent territory
- **SUPPORT**: Unit supports another unit's move/hold
- **CONVOY**: Fleet convoys army across water

### Victory Condition
Control 18 of the 34 supply centers to win.

## Usage with ElizaOS

```python
from elizaos import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin
from elizaos_atropos_diplomacy import DiplomacyEnvironment, DiplomacyAgent

# Create environment
env = DiplomacyEnvironment(press_mode=True)
await env.initialize()

# Create agents for each power
runtimes = {}
agents = {}

for power in env.powers:
    runtime = AgentRuntime(
        character=Character(name=f"Ambassador of {power}"),
        plugins=[get_openai_plugin()],
    )
    await runtime.initialize()
    agents[power] = DiplomacyAgent(runtime, power)

# Game loop
while not env.is_game_over():
    # Negotiation phase (if press mode)
    if env.press_mode:
        messages = await env.get_negotiation_round(agents)
    
    # Order submission phase
    orders = {}
    for power, agent in agents.items():
        state = env.get_state_for_power(power)
        orders[power] = await agent.decide_orders(state)
    
    # Execute orders
    result = await env.step(orders)
    print(f"Year {env.year}: {result.summary}")
```

## Atropos Integration

```python
from atropos import AtroposClient
from elizaos_atropos_diplomacy import DiplomacyEnvironment

# Register with Atropos for distributed training
client = AtroposClient()
client.register_environment(DiplomacyEnvironment)

# Collect multi-agent trajectories
trajectories = await client.collect_multiagent_rollouts(
    num_games=100,
    agents_per_game=7,
)
```

## Strategy Guide

### Opening Strategies
- **England**: Fleet to Norwegian Sea, army to Belgium
- **France**: Army to Burgundy, secure Iberia
- **Germany**: Negotiate with France and Russia
- **Russia**: South vs North expansion decision
- **Turkey**: Secure Black Sea, ally with one neighbor

### Diplomacy Tips
- Always negotiate, even with enemies
- Support neighbors against distant threats
- Be reliable early, opportunistic late
- Control supply centers, not territories

## Architecture

```
elizaos_atropos_diplomacy/
├── __init__.py           # Package exports
├── types.py              # Game types (Power, Province, Order, etc.)
├── map_data.py           # Map topology and supply centers
├── environment.py        # DiplomacyEnvironment class
├── adjudicator.py        # Order resolution logic
├── agent.py              # ElizaOS agent integration
├── negotiation.py        # Press/negotiation system
└── cli.py                # Command-line interface
```

## License

MIT License - Part of the ElizaOS project.
