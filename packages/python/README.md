# elizaOS Core (Python)

The Python implementation of elizaOS Core - the runtime and types for elizaOS AI agents.

## Installation

```bash
pip install elizaos
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

## Quick Start

```python
from elizaos import AgentRuntime, Character
from elizaos.types import UUID

# Define a character
character = Character(
    name="Assistant",
    bio="A helpful AI assistant.",
    system="You are a helpful and friendly assistant.",
)

# Create and initialize the runtime
async def main():
    runtime = AgentRuntime(
        character=character,
    )
    await runtime.initialize()

    # Runtime is now ready to process messages

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
```

## Architecture

### Core Types

- `UUID` - Universally unique identifier
- `Content` - Message content with text, actions, attachments
- `Memory` - Stored message or information
- `Entity` - User or agent representation
- `Room` - Conversation context
- `World` - Collection of rooms and entities

### Components

- `Action` - Define agent capabilities
- `Provider` - Supply contextual information
- `Evaluator` - Post-interaction analysis
- `Service` - Long-running integrations

### Plugin System

```python
from elizaos import Plugin, Action, Provider

my_plugin = Plugin(
    name="my-plugin",
    description="A custom plugin",
    actions=[...],
    providers=[...],
)
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

## License

MIT
