# Tic-Tac-Toe Demo - Python Version

A tic-tac-toe game demonstrating perfect play using minimax algorithm without any LLM.

## Running

```bash
cd examples/tic-tac-toe/python
python game.py
```

## How It Works

This Python version demonstrates the core concept:
- Custom model handlers that parse board state from text prompts
- Minimax algorithm for perfect play
- No LLM calls needed

In a full implementation with the Python elizaOS runtime, you would:
1. Create an `AgentRuntime` with no character (anonymous)
2. Register custom model handlers for `TEXT_LARGE` and `TEXT_SMALL`
3. The handlers would intercept model calls and return optimal moves

## Current Status

This implementation uses a simplified runtime simulation since the full Python
elizaOS runtime integration is still in development. The core logic (minimax,
board parsing, model handler) is fully functional and demonstrates the concept.

