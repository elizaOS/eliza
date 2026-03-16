# Bluesky Agent - Rust Implementation

A full-featured AI agent running on Bluesky, using the complete elizaOS pipeline.

## Building

```bash
cd bluesky-agent
cargo build --release
```

## Running

```bash
# Copy env.example to .env and fill in credentials
cp ../../env.example .env

# Run the agent
cargo run --release
```

## Testing

```bash
# Unit tests
cargo test

# Live integration tests (requires credentials)
cargo test --features live
```

## Architecture

The Rust implementation follows the same canonical elizaOS patterns:

1. **Full Pipeline Processing**: All messages go through `message_service.handle_message()`
2. **State Composition**: Providers (CHARACTER, RECENT_MESSAGES, ACTIONS) compose the state
3. **shouldRespond Evaluation**: LLM decides whether to respond
4. **Action Planning**: Available actions are planned and executed
5. **Callback-based Posting**: Responses are posted via callbacks

## Files

- `src/main.rs` - Main entry point and polling loop
- `src/character.rs` - Agent personality configuration
- `src/handlers.rs` - Event handlers for mentions and posts
- `tests/integration_tests.rs` - Unit and integration tests
