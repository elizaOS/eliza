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
- **Runtime migration service** compatible with TypeScript RuntimeMigrator
- **Plugin schema namespacing** for isolation
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

## Migration System

The package includes a migration service compatible with the TypeScript RuntimeMigrator:

```python
from elizaos_plugin_sql import MigrationService, derive_schema_name

# Create migration service
migration_service = MigrationService(engine)
await migration_service.initialize()

# Get migration status
status = await migration_service.get_status("@your-org/plugin-name")

# Derive schema name for plugin isolation
schema_name = derive_schema_name("@your-org/plugin-name")
# Returns: "your_org_plugin_name"
```

### Running Alembic Migrations

```bash
# Set database URL
export POSTGRES_URL="postgresql+asyncpg://user:pass@localhost/db"

# Generate a new migration
alembic revision --autogenerate -m "Add new table"

# Apply migrations
alembic upgrade head

# Rollback
alembic downgrade -1
```

## Development

```bash
# Install development dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Run migration tests
pytest tests/test_migrations.py

# Type checking
mypy elizaos_plugin_sql

# Linting
ruff check elizaos_plugin_sql
```

## License

MIT
