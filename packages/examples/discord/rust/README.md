# Discord Agent (Rust)

A full-featured Discord AI agent written in Rust using elizaOS.

## Prerequisites

- Rust 1.75+
- Discord bot credentials
- OpenAI API key

## Quick Start

```bash
# From repo root, ensure dependencies are built
cargo build --release -p discord-agent

# Set up environment
cd examples/discord
cp env.example .env
# Edit .env with your credentials

# Run the agent
cd rust/discord-agent
cargo run --release
```

## Development

```bash
# Run with debug logging
RUST_LOG=debug cargo run

# Run tests
cargo test

# Run live integration tests (requires credentials)
cargo test --features live
```

## Features

- Async/await with Tokio
- Graceful shutdown handling
- Structured logging with tracing
- Type-safe Discord API interactions
- Memory persistence with SQL

## Architecture

```
src/
├── main.rs       # Application entry point
├── lib.rs        # Library exports
├── character.rs  # Bot personality definition
└── handlers.rs   # Event handler implementations
```
