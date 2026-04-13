# elizaOS MCP Agent Server - Rust

Exposes an elizaOS agent as an MCP (Model Context Protocol) server using Rust.

## Requirements

- Rust 1.70+
- OpenAI API key

## Setup

```bash
# Set up environment
export OPENAI_API_KEY=your-api-key
```

## Usage

```bash
# Build and run
cargo run --release
```

The server runs on stdio and implements the MCP protocol.

## Building

```bash
cargo build --release
```

## Available Tools

- `chat` - Send a message to the agent
- `get_agent_info` - Get information about the agent
