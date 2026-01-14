# Tic-Tac-Toe Demo - Rust Version

A tic-tac-toe game demonstrating perfect play using minimax algorithm without any LLM.

## Running

```bash
cd examples/tic-tac-toe/rust

# Interactive (prompts for mode)
cargo run

# Watch AI vs AI
cargo run -- --watch

# Play vs AI
cargo run -- --human

# Benchmark
cargo run -- --bench
```

## How It Works

- The game loop sends each board update as a real Eliza `Memory`.
- Each turn is processed through `runtime.message_service().handle_message(...)` (canonical pipeline).
- A custom plugin intercepts `TEXT_LARGE` / `TEXT_SMALL` model calls and returns an XML response containing the optimal move computed via minimax.
- **No LLM calls are made** — the “model” is just a rule-based minimax handler.



