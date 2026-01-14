# Agentic Game of Life

A multi-agent simulation demonstrating emergent behavior using elizaOS. Watch 40+ autonomous agents evolve on a grid world through natural selection!

## Key Features

- **40+ Autonomous Agents**: Each with unique DNA (speed, vision, aggression, metabolism)
- **Self-Replication**: Agents reproduce when they have enough energy, passing mutated DNA to offspring
- **Evolution**: Over generations, natural selection favors survival strategies
- **No LLM Required**: Custom model handlers implement agent decision-making algorithmically
- **Real-time Visualization**: Watch the ecosystem evolve in your terminal

## How It Works

### Agent DNA

Each agent has traits that determine behavior:

| Trait      | Range   | Effect                                |
| ---------- | ------- | ------------------------------------- |
| Speed      | 1-3     | How many cells can move per turn      |
| Vision     | 1-5     | How far can see food and other agents |
| Aggression | 0-100%  | Fight vs flee tendency                |
| Metabolism | 0.5-2.0 | Energy efficiency (lower = better)    |

### Game Rules

1. **Energy**: Agents start with 100 energy, max 200
2. **Movement**: Moving costs energy based on speed and metabolism
3. **Food** (🌱): Spawns randomly, gives 30 energy when eaten
4. **Reproduction**: When energy > 150, spawn offspring with mutated DNA
5. **Combat**: Aggressive agents can steal energy from others on collision
6. **Death**: Energy reaches 0 = death

### Emergent Behaviors

Watch for these patterns:

- **Predator-Prey Dynamics**: Aggressive agents hunt weaker ones
- **Evolution of Speed**: Fast agents escape predators or catch prey
- **Vision Arms Race**: Better vision helps find food and avoid threats
- **Population Cycles**: Boom and bust cycles as food/predators fluctuate

## Running

```bash
# Standard speed
bun run examples/game-of-life/typescript/game.ts

# Fast mode (10x speed)
bun run examples/game-of-life/typescript/game.ts --fast

# With detailed statistics
bun run examples/game-of-life/typescript/game.ts --stats

# Combined
bun run examples/game-of-life/typescript/game.ts --fast --stats
```

### Legend

```
● Normal agent
◆ Aggressive agent (aggression > 70%)
▲ Fast agent (speed = 3)
◉ Sharp vision agent (vision >= 4)
🌱 Food
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    AgentRuntime                         │
│                 (Anonymous Character)                   │
├─────────────────────────────────────────────────────────┤
│  plugins:                                               │
│  ├── plugin-sql          (persistence)                  │
│  ├── bootstrap-plugin    (basic capabilities)           │
│  └── game-of-life-plugin (agent decision handlers)      │
├─────────────────────────────────────────────────────────┤
│  For each agent, each tick:                             │
│  runtime.messageService.handleMessage(runtime, message)  │
│           ↓                                             │
│  DefaultMessageService (full pipeline)                  │
│   - store memory                                        │
│   - compose state                                       │
│   - runtime.useModel(TEXT_LARGE, { prompt })            │
│           ↓                                             │
│  decisionModelHandler() ← NOT an LLM (rule-based XML)    │
│           ↓                                             │
│  runtime.processActions() → action handlers mutate world │
└─────────────────────────────────────────────────────────┘
```

## Configuration

Edit `CONFIG` in `game.ts` to customize:

```typescript
const CONFIG = {
  WORLD_WIDTH: 40, // Grid width
  WORLD_HEIGHT: 25, // Grid height
  INITIAL_AGENTS: 40, // Starting population
  MAX_AGENTS: 100, // Population cap
  STARTING_ENERGY: 100, // Energy at birth
  REPRODUCTION_THRESHOLD: 150, // Energy needed to reproduce
  FOOD_SPAWN_RATE: 0.02, // Food spawn probability
  MUTATION_RATE: 0.2, // Chance of DNA mutation
  // ... more settings
};
```

## What Makes This Cool

1. **No LLM Calls**: Pure algorithmic agents, instant decisions
2. **Emergent Complexity**: Simple rules → complex ecosystem behavior
3. **Visual Evolution**: See DNA traits change across generations
4. **elizaOS Integration**: Demonstrates custom model handlers and plugin system
5. **Self-Replicating Agents**: True digital life simulation!

## Performance

- Runs 40+ agents simultaneously
- ~150ms per tick (configurable)
- Zero API calls, zero cost
- Pure in-memory simulation
