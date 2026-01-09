# elizaOS SQL Plugin (Python)

The Python implementation of the elizaOS SQL Plugin - PostgreSQL and PGLite database adapters for elizaOS agents.

## Installation

```bash
pip install elizaos-plugin-sql
```

## Features

- **PostgreSQL adapter** with vector search support via pgvector
- **PGLite adapter** for lightweight local development
- **SQLAlchemy ORM** with async support
- **Automatic migrations** using Alembic
- **Vector embeddings** for semantic search
- **Full type safety** with Pydantic models

## Quick Start

### PostgreSQL

```python
from elizaos import AgentRuntime, Character
from elizaos_plugin_sql import PostgresAdapter

# Create the database adapter
adapter = PostgresAdapter(
    connection_string="postgresql+asyncpg://user:pass@localhost/db",
    agent_id="12345678-1234-1234-1234-123456789012",
)

# Create the runtime with the adapter
character = Character(name="Agent", bio="A helpful agent")
runtime = AgentRuntime(
    character=character,
    adapter=adapter,
)

await runtime.initialize()
```

### PGLite (Local Development)

```python
from elizaos import AgentRuntime, Character
from elizaos_plugin_sql import PGLiteAdapter

# Create a local PGLite adapter
adapter = PGLiteAdapter(
    data_dir="./data/pglite",
    agent_id="12345678-1234-1234-1234-123456789012",
)

character = Character(name="Agent", bio="A helpful agent")
runtime = AgentRuntime(
    character=character,
    adapter=adapter,
)

await runtime.initialize()
```

## Schema

The plugin provides the following database tables:

- `agents` - Agent configurations
- `entities` - Users and other entities
- `components` - Entity components
- `rooms` - Conversation rooms
- `worlds` - World containers
- `memories` - Stored memories/messages
- `embeddings` - Vector embeddings
- `relationships` - Entity relationships
- `tasks` - Task queue
- `cache` - Key-value cache
- `logs` - Activity logs

## Development

```bash
# Install development dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_sql

# Linting
ruff check elizaos_plugin_sql
```

## License

MIT

