# elizaos-plugin-localdb (Python)

Simple JSON-based local database storage for elizaOS.

## Installation

```bash
pip install elizaos-plugin-localdb
```

## Usage

```python
from elizaos_plugin_localdb import LocalDatabaseAdapter, JsonFileStorage

# Create storage and adapter
storage = JsonFileStorage("./data")
adapter = LocalDatabaseAdapter(storage, agent_id="my-agent-id")

# Initialize
await adapter.init()

# Use the adapter...
await adapter.create_memory(memory, "messages")

# Close when done
await adapter.close()
```

## Features

- Zero configuration - no database required
- JSON file-based storage
- Built-in HNSW vector search
- Implements IDatabaseAdapter interface



