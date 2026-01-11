# elizaos-plugin-inmemorydb

A pure in-memory, ephemeral database adapter for elizaOS (Python implementation). All data is completely lost on process restart or when `close()` is called.

## Features

- **Zero Configuration**: No database setup required - just works out of the box
- **Zero Persistence**: Data is never written to disk
- **Completely Ephemeral**: All data is lost when the process ends
- **Vector Search**: Built-in HNSW index for semantic similarity search (also ephemeral)
- **Async Support**: Full async/await support with Python 3.11+

## When to Use

This plugin is ideal for:

- ✅ **Testing and CI/CD**: Perfect for tests that need a fresh database each run
- ✅ **Stateless deployments**: When you want agents to start fresh each time
- ✅ **Development**: Quick prototyping without persistence overhead
- ✅ **Privacy-focused applications**: When data should never be stored
- ✅ **Demos and examples**: Clean slate for each demonstration

**Not recommended for:**

- ❌ Production systems that need data persistence
- ❌ Long-running agents that need to remember past interactions
- ❌ Multi-process deployments (data is not shared between processes)

## Installation

```bash
pip install elizaos-plugin-inmemorydb
```

## Quick Start

```python
from elizaos_plugin_inmemorydb import InMemoryDatabaseAdapter, MemoryStorage

# Create storage and adapter
storage = MemoryStorage()
adapter = InMemoryDatabaseAdapter(storage, agent_id)
await adapter.init()

# Use the adapter...

# When done, close to clear all data
await adapter.close()
```

## License

MIT




