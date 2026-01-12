# Bluesky Agent - Rust Implementation

A full-featured Bluesky AI agent implemented in Rust using elizaOS.

## Prerequisites

- Rust 1.70 or later
- OpenAI API key (or other model provider)
- Bluesky account with app password

## Quick Start

```bash
# Navigate to the agent directory
cd bluesky-agent

# Copy environment template and fill in credentials
cp ../../env.example .env
# Edit .env with your credentials

# Build and run
cargo run --release
```

## Building

```bash
# Debug build
cargo build

# Release build
cargo build --release

# Run tests
cargo test

# Run live integration tests (requires credentials)
cargo test --features live
```

## Project Structure

```
bluesky-agent/
├── Cargo.toml          # Project configuration
├── src/
│   ├── main.rs         # Entry point
│   ├── lib.rs          # Library exports
│   ├── character.rs    # Agent personality
│   └── handlers.rs     # Event handlers
└── tests/
    └── integration.rs  # Integration tests
```

## Features

- **Async/Await**: Built on Tokio for efficient async operations
- **Strong Types**: Full type safety with Rust's type system
- **Error Handling**: Comprehensive error handling with `anyhow`
- **Logging**: Structured logging with `tracing`
- **Graceful Shutdown**: Proper signal handling for clean shutdown

## Configuration

Environment variables (see `../../env.example`):

| Variable | Description | Required |
|----------|-------------|----------|
| `BLUESKY_HANDLE` | Your Bluesky handle | Yes |
| `BLUESKY_PASSWORD` | App password | Yes |
| `OPENAI_API_KEY` | OpenAI API key | Yes* |
| `BLUESKY_DRY_RUN` | Simulate without posting | No |
| `BLUESKY_POLL_INTERVAL` | Seconds between polls | No |

*Or another model provider like `ANTHROPIC_API_KEY`

## Development

```bash
# Watch for changes and rebuild
cargo watch -x run

# Run with debug logging
RUST_LOG=debug cargo run

# Check for issues
cargo clippy
cargo fmt --check
```

## License

MIT - See the main elizaOS repository for details.
