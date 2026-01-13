# Agentic Game of Life

A multi-agent evolution simulation demonstrating elizaOS's ability to run autonomous agents **without an LLM**.

## Key Features

- **Self-Replicating Agents**: 40+ agents with DNA that mutates during reproduction
- **Emergent Evolution**: Natural selection favors survival strategies over generations
- **No LLM Required**: Custom model handlers implement agent decision-making
- **Real-time Visualization**: Watch the ecosystem evolve in your terminal

## Available Implementations

- [TypeScript](./typescript/) - Full implementation with visual simulation
- [Python](./python/) - Minimal canonical pipeline demo (message_service + actions, no LLM)
- [Rust](./rust/) - Minimal canonical pipeline demo (message_service + rule-based output, no LLM)

## How It Works

Agents have DNA (speed, vision, aggression, metabolism) that determines behavior:

1. **Perceive**: Scan for nearby food and other agents
2. **Decide**: Choose to move toward food, flee from threats, or hunt prey
3. **Act**: Move, eat food, fight, or reproduce
4. **Evolve**: Offspring inherit mutated DNA from parents

Watch emergent behaviors like predator-prey dynamics, population cycles, and evolution of traits!

## Quick Start

```bash
# Standard mode
bun run examples/game-of-life/typescript/game.ts

# Fast mode (10x speed)
bun run examples/game-of-life/typescript/game.ts --fast

# With statistics
bun run examples/game-of-life/typescript/game.ts --stats
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
│  Each tick, for each agent:                             │
│  perceive() → decide() → act() → evolve()               │
│                                                         │
│  All decisions made algorithmically (no LLM!)           │
└─────────────────────────────────────────────────────────┘
```

## What Makes This Cool

- **Digital Life**: True self-replicating agents with heredity and mutation
- **Zero Cost**: No API calls, pure algorithmic simulation
- **elizaOS Showcase**: Custom model handlers, plugin system, agent runtime
- **Emergent Complexity**: Simple rules → rich ecosystem dynamics
