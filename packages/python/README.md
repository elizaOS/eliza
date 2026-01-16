# elizaOS Core (Python)

The Python implementation of elizaOS Core - the runtime and types for elizaOS AI agents.

## Installation

### From Repository (Development)

```bash
# From the repo root
cd eliza

# Create and activate virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install the core package
pip install -e packages/python

# Install an LLM provider (required)
pip install -e plugins/plugin-openai/python

# Install a database adapter (required for message handling)
pip install -e plugins/plugin-inmemorydb/python
```

### From PyPI

```bash
pip install elizaos elizaos-plugin-openai elizaos-plugin-inmemorydb
```

## Quick Start

### Run the Chat Example

```bash
# Set your OpenAI API key
export OPENAI_API_KEY="your-key"

# Run the example
python examples/chat/python/chat.py
```

### Create Your Own Agent

```python
from __future__ import annotations
import asyncio
import os
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()  # Load .env file

from uuid6 import uuid7
from elizaos import Character, ChannelType, Content, Memory
from elizaos.runtime import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin
from elizaos_plugin_inmemorydb import plugin as inmemorydb_plugin

async def main() -> None:
    # Define your agent's character
    character = Character(
        name="Eliza",
        username="eliza",
        bio="A helpful AI assistant.",
        system="You are helpful and concise.",
    )

    # Create runtime with plugins
    runtime = AgentRuntime(
        character=character,
        plugins=[
            get_openai_plugin(),    # LLM provider
            inmemorydb_plugin,      # Database adapter
        ],
    )

    user_id = uuid7()
    room_id = uuid7()

    try:
        await runtime.initialize()
        print(f"🤖 Chat with {character.name} (type 'quit' to exit)\n")

        while True:
            user_input = input("You: ")
            if not user_input.strip() or user_input.lower() in ("quit", "exit"):
                break

            message = Memory(
                entity_id=user_id,
                room_id=room_id,
                content=Content(
                    text=user_input,
                    source="cli",
                    channel_type=ChannelType.DM.value,
                ),
            )

            result = await runtime.message_service.handle_message(runtime, message)
            print(f"\n{character.name}: {result.response_content.text}\n")

        print("Goodbye! 👋")
    finally:
        await runtime.stop()

if __name__ == "__main__":
    asyncio.run(main())
```

## Features

- **Strong typing** with Pydantic models and full type hints
- **Plugin architecture** for extensibility
- **Character configuration** for defining agent personalities
- **Memory system** for conversation history and knowledge
- **Event system** for reactive programming
- **Service abstraction** for external integrations

## Runtime Settings (cross-language parity)

These settings are read by the runtime/message loop to keep behavior aligned with the TypeScript and Rust implementations:

- `ALLOW_NO_DATABASE`: when truthy, the runtime may run without a database adapter (benchmarks/tests).
- `USE_MULTI_STEP`: when truthy, enable the iterative multi-step workflow.
- `MAX_MULTISTEP_ITERATIONS`: maximum iterations for multi-step mode (default: `6`).

### Benchmark & Trajectory Tracing

Benchmarks and harnesses can attach metadata to inbound messages:

- `message.metadata.trajectoryStepId`: enables trajectory tracing for provider access + model calls.
- `message.metadata.benchmarkContext`: enables the `CONTEXT_BENCH` provider and sets `state.values["benchmark_has_context"]=True`, which forces action-based execution to exercise the full loop.

## Model output contract (XML preferred, plain text tolerated)

The canonical message loop expects model outputs in the `<response>...</response>` XML format (with `<actions>`, `<providers>`, and `<text>` fields).

Some deterministic/offline backends may return **plain text** instead. In that case, the runtime will treat the raw output as a simple **`REPLY`** so the system remains usable even when strict XML formatting is unavailable.

## Core Types

- `UUID` - Universally unique identifier
- `Content` - Message content with text, actions, attachments
- `Memory` - Stored message or information
- `Entity` - User or agent representation
- `Room` - Conversation context
- `World` - Collection of rooms and entities

## Components

- `Action` - Define agent capabilities
- `Provider` - Supply contextual information
- `Evaluator` - Post-interaction analysis
- `Service` - Long-running integrations

## Plugin System

```python
from elizaos import Plugin, Action, Provider

my_plugin = Plugin(
    name="my-plugin",
    description="A custom plugin",
    actions=[...],
    providers=[...],
)
```

## Available Plugins

### LLM Providers

| Plugin | Path | Description |
|--------|------|-------------|
| OpenAI | `plugins/plugin-openai/python` | GPT-4, embeddings, DALL-E |
| Anthropic | `plugins/plugin-anthropic/python` | Claude models |
| Ollama | `plugins/plugin-ollama/python` | Local LLMs |
| Groq | `plugins/plugin-groq/python` | Fast inference |

### Database Adapters

| Plugin | Path | Description |
|--------|------|-------------|
| InMemoryDB | `plugins/plugin-inmemorydb/python` | Ephemeral storage (dev/testing) |
| SQL | `plugins/plugin-sql/python` | PostgreSQL/PGLite |

### Platform Integrations

| Plugin | Path | Description |
|--------|------|-------------|
| Telegram | `plugins/plugin-telegram/python` | Telegram bots |
| Discord | `plugins/plugin-discord/python` | Discord bots |

## Environment Variables

```bash
# Required for OpenAI plugin
OPENAI_API_KEY=sk-...

# Optional
LOG_LEVEL=INFO
```

## Development

```bash
# Install development dependencies
pip install -e ".[dev]"

# (Reproducible/pinned) Generate lockfiles used by CI
pip install pip-tools
pip-compile requirements.in -o requirements.lock
pip-compile requirements-dev.in -o requirements-dev.lock

# Run tests
pytest

# Type checking
mypy elizaos

# Linting
ruff check elizaos
```

## Examples

See `examples/` directory for complete working examples:

- `examples/chat/python/` - CLI chat agent
- `examples/telegram/python/` - Telegram bot
- `examples/discord/python/` - Discord bot
- `examples/rest-api/fastapi/` - REST API server

## License

MIT
