# Tic-Tac-Toe Demo - No LLM, Pure Minimax

A tic-tac-toe game demonstrating elizaOS's ability to run agents **without an LLM**. This example showcases:

- **No Character Required**: Uses the new anonymous character feature (`Agent-N`)
- **No LLM Calls**: Custom model handlers implement perfect play via minimax
- **Custom Model Handlers**: Intercepts `TEXT_LARGE` and `TEXT_SMALL` to return optimal moves
- **plugin-sql**: Uses PGLite in-memory database for persistence

## How It Works

Instead of calling an LLM, this agent registers custom model handlers that:

1. Parse the board state from the text prompt
2. Use the minimax algorithm to find the optimal move
3. Return the move as a simple number (0-8)

The agent **never loses** - it will always win or draw!

## Running

```bash
# Interactive mode (prompts for game mode)
bun run examples/tic-tac-toe/typescript/game.ts

# Watch AI vs AI (non-interactive)
bun run examples/tic-tac-toe/typescript/game.ts --watch

# Play against AI
bun run examples/tic-tac-toe/typescript/game.ts --human

# Run benchmark
bun run examples/tic-tac-toe/typescript/game.ts --bench
```

### Command Line Options

| Flag          | Alias                      | Description               |
| ------------- | -------------------------- | ------------------------- |
| `--watch`     | `-w`, `watch`              | AI vs AI mode             |
| `--human`     | `-h`, `human`, `play`      | Play against AI           |
| `--bench`     | `-b`, `bench`, `benchmark` | Performance benchmark     |
| `--no-prompt` | `-y`                       | Skip "play again" prompts |

## Game Modes

1. **Play vs AI** - You play as X, the perfect AI plays as O
2. **Watch AI vs AI** - Two perfect AIs play each other (always draws!)
3. **Benchmark** - Performance test running 100 games instantly

## Key Code

### Anonymous Character (No Character Required)

```typescript
const runtime = new AgentRuntime({
  // No character - uses anonymous Agent-N
  plugins: [sqlPlugin, ticTacToePlugin],
});
```

### Custom Model Handler (No LLM)

```typescript
const ticTacToePlugin: Plugin = {
  name: "tic-tac-toe",
  description: "Perfect tic-tac-toe AI using minimax algorithm",
  priority: 100, // High priority to override LLM handlers

  models: {
    [ModelType.TEXT_LARGE]: ticTacToeModelHandler,
    [ModelType.TEXT_SMALL]: ticTacToeModelHandler,
  },
};
```

### Minimax Algorithm

The AI uses the classic minimax algorithm with depth-based scoring to find the optimal move. It evaluates all possible game states and chooses the move that leads to the best outcome.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    AgentRuntime                         │
│                 (Anonymous Character)                   │
├─────────────────────────────────────────────────────────┤
│  plugins:                                               │
│  ├── plugin-sql         (persistence)                   │
│  └── tic-tac-toe-plugin (custom model handlers)         │
├─────────────────────────────────────────────────────────┤
│  runtime.messageService.handleMessage(runtime, message) │
│           ↓                                             │
│  ticTacToeModelHandler() ← NOT an LLM!                  │
│           ↓                                             │
│  parseBoardFromText() → minimax() → optimal move        │
└─────────────────────────────────────────────────────────┘
```

## Position Reference

```
 0 | 1 | 2
---+---+---
 3 | 4 | 5
---+---+---
 6 | 7 | 8
```

## Performance

Since there's no LLM latency, the AI responds instantly:

- ~100 games per second on typical hardware
- Zero API calls
- Zero cost
