# Agentic Game of Life - Rust Version

A minimal Rust demo that routes an **environment tick** through the **full elizaOS pipeline**:

- `runtime.message_service().handle_message(&runtime, &mut message, ...)`

No LLM is used: a custom `TEXT_LARGE`/`TEXT_SMALL` model handler returns deterministic XML.

## Running

```bash
cargo run --manifest-path examples/game-of-life/rust/game-of-life/Cargo.toml
```

## What to Look For

- **Canonical entrypoint**: the demo calls `message_service().handle_message(...)` (no bypass).
- **Rule-based output**: the model handler returns deterministic XML like `<actions>EAT</actions>` / `<actions>MOVE_TOWARD_FOOD</actions>` / `<actions>WANDER</actions>`.
- **Full pipeline**: message is stored (if an adapter is present), state is composed, a model handler is invoked, XML is parsed, and selected actions execute via `process_selected_actions(...)`.
