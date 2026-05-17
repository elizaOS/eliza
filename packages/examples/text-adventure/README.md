# Text adventure

AI-driven text adventure: the agent chooses actions in a small dungeon (LLM required).

## Prerequisites

From the **elizaOS repository root**:

```bash
bun install
export OPENAI_API_KEY=your_key_here
```

## Run

```bash
cd examples/text-adventure
cp .env.example .env   # set OPENAI_API_KEY
bun install

# Quieter logs
LOG_LEVEL=fatal bun run game.ts

# Optional persistent DB
PGLITE_DATA_DIR=./adventure-db LOG_LEVEL=fatal bun run game.ts
```

## Features

- Multiple rooms, items, and enemies
- Autonomous or guided play (see `game.ts` for flags)
- Uses `ModelType.TEXT_SMALL` for action selection

## Related examples

- `examples/chat/chat.ts` — CLI chat
- `examples/tic-tac-toe/game.ts` — no-LLM minimax demo
- `examples/game-of-life/game.ts` — no-LLM multi-agent simulation
