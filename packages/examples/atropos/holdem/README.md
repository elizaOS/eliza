# ElizaOS Atropos - Texas Hold'em Poker Environment

A Texas Hold'em poker environment for training ElizaOS agents using the Atropos RL framework.

## Overview

This environment implements No-Limit Texas Hold'em poker, allowing ElizaOS agents to:
- Learn poker strategy through self-play
- Understand betting dynamics and pot odds
- Develop opponent modeling skills
- Practice bluffing and value betting

## Installation

```bash
# From the repository root
pip install -e examples/atropos/holdem
```

## Quick Start

```bash
# Watch AI play heads-up
python -m elizaos_atropos_holdem --mode auto

# Play against the AI
python -m elizaos_atropos_holdem --mode interactive

# Run tournament simulation
python -m elizaos_atropos_holdem --mode tournament

# Multi-player game
python -m elizaos_atropos_holdem --players 6
```

## Environment Details

### Game Rules
- **No-Limit Texas Hold'em** format
- 2-9 players supported
- Standard 52-card deck
- Big blind/small blind structure

### Game Phases
1. **Pre-flop**: Two hole cards dealt, first betting round
2. **Flop**: Three community cards, second betting round
3. **Turn**: Fourth community card, third betting round
4. **River**: Fifth community card, final betting round
5. **Showdown**: Best hand wins the pot

### Action Space
- `FOLD`: Forfeit the hand
- `CHECK`: Pass without betting (when allowed)
- `CALL`: Match the current bet
- `RAISE X`: Increase the bet to X
- `ALL_IN`: Bet all remaining chips

### Observation Space
- Hole cards (player's private cards)
- Community cards
- Current pot size
- Player stacks
- Betting history
- Position information

### Rewards
- Profit/loss at end of hand
- Normalized by big blind

## Usage with ElizaOS

```python
from elizaos import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin
from elizaos_atropos_holdem import HoldemEnvironment, HoldemAgent

# Create environment
env = HoldemEnvironment(num_players=2, starting_stack=1000, blinds=(5, 10))
await env.initialize()

# Create agents
agents = []
for i in range(2):
    runtime = AgentRuntime(plugins=[get_openai_plugin()])
    await runtime.initialize()
    agents.append(HoldemAgent(runtime, position=i))

# Play hands
for hand in range(100):
    state = await env.reset()
    
    while not state.hand_over:
        current_player = state.current_player
        action = await agents[current_player].decide(state)
        state = await env.step(action)
    
    # Update agent stats
    for i, agent in enumerate(agents):
        agent.record_result(state.payouts[i])
```

## Atropos Integration

```python
from atropos import AtroposClient
from elizaos_atropos_holdem import HoldemEnvironment

# Register with Atropos
client = AtroposClient()
client.register_environment(HoldemEnvironment)

# Collect poker trajectories
trajectories = await client.collect_multiagent_rollouts(
    num_hands=10000,
    players_per_hand=2,
)
```

## Hand Rankings

| Rank | Name | Example |
|------|------|---------|
| 1 | Royal Flush | A♠ K♠ Q♠ J♠ T♠ |
| 2 | Straight Flush | 9♥ 8♥ 7♥ 6♥ 5♥ |
| 3 | Four of a Kind | Q♣ Q♦ Q♥ Q♠ 7♦ |
| 4 | Full House | J♠ J♥ J♦ 4♣ 4♠ |
| 5 | Flush | K♦ J♦ 8♦ 6♦ 3♦ |
| 6 | Straight | T♠ 9♦ 8♥ 7♣ 6♠ |
| 7 | Three of a Kind | 8♣ 8♦ 8♥ K♠ 3♦ |
| 8 | Two Pair | A♠ A♦ 5♣ 5♥ Q♦ |
| 9 | One Pair | K♥ K♣ 7♠ 4♦ 2♣ |
| 10 | High Card | A♦ J♣ 8♠ 6♥ 2♦ |

## Strategy Concepts

### Position
- **Early Position**: More cautious, stronger hands required
- **Late Position**: Can play wider range, more information
- **Button**: Best position, acts last post-flop

### Pot Odds
- Compare bet size to pot size
- Call if hand equity > pot odds
- Example: $50 to call into $100 pot = 33% odds needed

### Hand Categories
- **Premium**: AA, KK, QQ, AK
- **Strong**: JJ, TT, AQ, AJ
- **Playable**: 99-22, suited connectors
- **Marginal**: Weak aces, small pairs

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `num_players` | `2` | Number of players (2-9) |
| `starting_stack` | `1000` | Initial chip count |
| `small_blind` | `5` | Small blind amount |
| `big_blind` | `10` | Big blind amount |

## Architecture

```
elizaos_atropos_holdem/
├── __init__.py           # Package exports
├── types.py              # Game types (Card, Hand, Action, etc.)
├── deck.py               # Card deck and shuffling
├── hand_evaluator.py     # Hand strength evaluation
├── environment.py        # HoldemEnvironment class
├── agent.py              # ElizaOS agent integration
└── cli.py                # Command-line interface
```

## License

MIT License - Part of the ElizaOS project.
