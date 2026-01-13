# Tic-Tac-Toe Demo - No LLM, Pure Minimax

A tic-tac-toe game demonstrating elizaOS's ability to run agents **without an LLM**.

## Key Features

- **No Character Required**: Uses the new anonymous character feature (`Agent-N`)
- **No LLM Calls**: Custom model handlers implement perfect play via minimax
- **Custom Model Handlers**: Intercepts `TEXT_LARGE` and `TEXT_SMALL` to return optimal moves
- **plugin-sql**: Uses PGLite in-memory database for persistence

## Available Implementations

- [TypeScript](./typescript/) - Full implementation with interactive play
- [Python](./python/) - Full Eliza runtime integration (message_service.handle_message)
- [Rust](./rust/) - Full Eliza runtime integration (message_service.handle_message)

## How It Works

Instead of calling an LLM, this agent registers custom model handlers that:

1. Parse the board state from the text prompt
2. Use the minimax algorithm to find the optimal move
3. Return the move as a simple number (0-8)

The agent **never loses** - it will always win or draw!

## Quick Start

```bash
# TypeScript
bun run examples/tic-tac-toe/typescript/game.ts
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    AgentRuntime                         │
│                 (Anonymous Character)                   │
├─────────────────────────────────────────────────────────┤
│  plugins:                                               │
│  ├── plugin-sql         (persistence)                   │
│  ├── bootstrap-plugin   (basic capabilities)            │
│  └── tic-tac-toe-plugin (custom model handlers)         │
├─────────────────────────────────────────────────────────┤
│  runtime.useModel(TEXT_SMALL, { prompt: boardState })   │
│           ↓                                             │
│  ticTacToeModelHandler() ← NOT an LLM!                  │
│           ↓                                             │
│  parseBoardFromText() → minimax() → optimal move        │
└─────────────────────────────────────────────────────────┘
```

## Performance

Since there's no LLM latency, the AI responds instantly:

- ~100 games per second on typical hardware
- Zero API calls
- Zero cost
