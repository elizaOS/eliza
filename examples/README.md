# elizaOS Examples

This directory contains example applications demonstrating elizaOS in different languages.

## Examples Overview

Each language directory contains two main examples:

| Example | Description |
|---------|-------------|
| **chat** | Interactive CLI chat with an AI agent |
| **adventure-game** | Text adventure game with AI-powered decision making |

## Quick Start

### Prerequisites

1. Set your OpenAI API key:
   ```bash
   export OPENAI_API_KEY=your_key_here
   ```

2. Build the project (from repo root):
   ```bash
   bun install
   bun run build
   ```

## Language-Specific Instructions

### TypeScript (`examples/typescript/`)

```bash
# Chat example
bun run examples/typescript/chat.ts

# Adventure game
LOG_LEVEL=fatal bun run examples/typescript/adventure-game.ts
```

### Rust-WASM (`examples/rust-wasm/`)

TypeScript examples with optional Rust-WASM interop for cross-language type compatibility.

```bash
# Build WASM module (optional, for WASM features)
cd packages/core/rust && ./build-wasm.sh && cd -

# Chat example
bun run examples/rust-wasm/chat.ts

# Adventure game
LOG_LEVEL=fatal bun run examples/rust-wasm/adventure-game.ts
```

### Python (`examples/python/`)

```bash
# Setup virtual environment
python3 -m venv examples/python/.venv --without-pip
curl -sS https://bootstrap.pypa.io/get-pip.py | ./examples/python/.venv/bin/python
./examples/python/.venv/bin/python -m pip install -e packages/core/python -e packages/plugin-openai/python

# Chat example
./examples/python/.venv/bin/python examples/python/chat.py

# Adventure game
LOG_LEVEL=fatal ./examples/python/.venv/bin/python examples/python/adventure-game.py
```

### Rust (`examples/rust/`)

Pure Rust examples using native elizaOS Rust implementation.

```bash
# Chat example
cd examples/rust/standalone-cli-chat
cargo run

# Adventure game
cd examples/rust/standalone-adventure-game
cargo run
```

## Example Descriptions

### Chat

A simple interactive CLI chat application demonstrating:
- AgentRuntime initialization with plugins
- Message handling and response streaming
- Basic conversation flow

**APIs used:**
- `AgentRuntime` / `runtime.initialize()`
- `runtime.messageService.handleMessage()`
- `createMessageMemory()` / `Memory`

### Adventure Game

A text adventure game where an AI agent explores a dungeon, making strategic decisions. Demonstrates:
- AI decision making with `runtime.useModel()`
- Game state management
- Two modes: Watch AI play or Interactive mode

**APIs used:**
- `AgentRuntime` / `runtime.initialize()`
- `runtime.useModel(ModelType.TEXT_SMALL, {...})`
- Custom game engine integration

**Game Features:**
- Explore 7 dungeon rooms
- Collect items (torch, sword, key, health potions)
- Fight enemies (goblin, skeleton, dragon)
- Win by defeating the dragon and claiming the treasure

## API Comparison

All examples use identical APIs across languages:

| Operation | TypeScript | Python | Rust |
|-----------|------------|--------|------|
| Create runtime | `new AgentRuntime({...})` | `AgentRuntime(...)` | `AgentRuntime::new(...)` |
| Initialize | `await runtime.initialize()` | `await runtime.initialize()` | `runtime.initialize().await` |
| Use model | `runtime.useModel(ModelType.TEXT_SMALL, {...})` | `runtime.use_model("TEXT_SMALL", {...})` | `runtime.use_model("TEXT_SMALL", {...}).await` |
| Stop | `await runtime.stop()` | `await runtime.stop()` | `runtime.stop().await` |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | (required) | OpenAI API key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | API base URL |
| `OPENAI_SMALL_MODEL` | `gpt-5-mini` | Model for TEXT_SMALL |
| `OPENAI_LARGE_MODEL` | `gpt-5` | Model for TEXT_LARGE |
| `LOG_LEVEL` | `info` | Set to `fatal` to suppress logs |
| `PGLITE_DATA_DIR` | `memory://` | PGLite storage (TypeScript only) |
| `POSTGRES_URL` | (optional) | PostgreSQL connection string |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Example Application                          │
│  (chat.ts, adventure-game.ts, chat.py, main.rs)                 │
├─────────────────────────────────────────────────────────────────┤
│                     elizaOS Core Runtime                         │
│  AgentRuntime, MessageService, Model Handlers                    │
├─────────────────────────────────────────────────────────────────┤
│                        Plugins                                   │
│  plugin-openai, plugin-sql, core (bootstrap)                     │
├─────────────────────────────────────────────────────────────────┤
│                    Language Bindings                             │
│  TypeScript (native), Python (elizaos), Rust (elizaos crate)    │
└─────────────────────────────────────────────────────────────────┘
```
