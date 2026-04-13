# Agentic Game of Life - Python Version

A tiny grid-world simulation demonstrating **the full elizaOS message pipeline** with **no LLM**.

## Running

```bash
cd examples/game-of-life/python
pip install -r requirements.txt
python game.py
```

## How It Works

Each tick is processed by routing an **environment message** through the canonical entrypoint:

- `runtime.message_service.handle_message(runtime, message)`

That triggers:

- saving the message to memory (when an adapter is present)
- `runtime.compose_state(...)`
- `runtime.use_model(TEXT_LARGE, { prompt })`
- a **custom rule-based model handler** that returns deterministic XML:
  - `<actions>MOVE_TOWARD_FOOD</actions>` / `<actions>EAT</actions>` / `<actions>WANDER</actions>`
- `runtime.process_actions(...)` which executes real elizaOS `Action` handlers (mutating the world)

## Current Status

This implementation is intentionally minimal (single agent) but fully canonical:
**no bypassing** and **no “pretend” agent loop**.
