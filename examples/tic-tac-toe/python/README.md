# Tic-Tac-Toe Demo - Python Version

A tic-tac-toe game demonstrating perfect play using minimax algorithm without any LLM.

## Running

```bash
cd examples/tic-tac-toe/python
python game.py
```

## How It Works

This Python version uses the **real elizaOS Python runtime**:

- All environment updates are sent as Eliza `Memory` objects
- Each turn is processed via `runtime.message_service.handle_message(...)` (full pipeline)
- A custom model handler intercepts `TEXT_LARGE` / `TEXT_SMALL` and returns the optimal move using minimax (no LLM)

The AI move selection is **rule-based** (pure minimax), but the message flow is **not bypassed**:
it goes through Eliza’s canonical message service.



