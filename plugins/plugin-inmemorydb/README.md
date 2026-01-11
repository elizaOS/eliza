# @elizaos/plugin-inmemorydb

A pure in-memory, ephemeral database adapter for elizaOS. All data is completely lost on process restart or when `close()` is called.

## Features

- **Zero Configuration**: No database setup required - just works out of the box
- **Zero Persistence**: Data is never written to disk or localStorage
- **Completely Ephemeral**: All data is lost when the process ends
- **Cross-Platform**: Works identically in Node.js and browsers
- **Vector Search**: Built-in HNSW index for semantic similarity search (also ephemeral)
- **Same Interface**: Implements the standard `IDatabaseAdapter` interface

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
bun add @elizaos/plugin-inmemorydb
```

## Quick Start

### Node.js

```typescript
import { plugin } from "@elizaos/plugin-inmemorydb";

// Add to your agent configuration
const agent = {
  plugins: [plugin],
  // ...
};
```

### Browser

```typescript
import { plugin } from "@elizaos/plugin-inmemorydb";

// Add to your agent configuration
const agent = {
  plugins: [plugin],
  // ...
};
```

## API

### Creating an Adapter Manually

```typescript
import {
  InMemoryDatabaseAdapter,
  MemoryStorage,
} from "@elizaos/plugin-inmemorydb";

const storage = new MemoryStorage();
const adapter = new InMemoryDatabaseAdapter(storage, agentId);
await adapter.init();

// Use the adapter...

// When done, close to clear all data
await adapter.close();
```

### Clearing Data

```typescript
// Clear all data (adapter still usable)
await storage.clear();

// Or close the adapter entirely (also clears data)
await adapter.close();
```

## Comparison with Other Database Plugins

| Feature         | plugin-inmemorydb  | plugin-localdb     | plugin-sql          |
| --------------- | ------------------ | ------------------ | ------------------- |
| Persistence     | None (ephemeral)   | JSON files         | PostgreSQL          |
| Setup           | Zero configuration | Zero configuration | Requires PostgreSQL |
| Data on restart | Lost               | Preserved          | Preserved           |
| Best for        | Testing/dev        | Local dev          | Production          |

## How It Works

The plugin uses simple JavaScript `Map` data structures to store all data:

```
Memory
├── Collections (Map<string, Map<string, unknown>>)
│   ├── agents: Map<id, agent>
│   ├── memories: Map<id, memory>
│   ├── rooms: Map<id, room>
│   └── ... (other collections)
└── HNSW Vector Index (in-memory)
```

When the process ends or `close()` is called, all Maps are cleared and data is gone forever.

## Vector Search

The plugin includes an ephemeral HNSW (Hierarchical Navigable Small World) implementation for vector similarity search:

- Semantic memory search
- Similar content retrieval
- Embedding-based queries

The vector index is also purely in-memory and is cleared with all other data.

## License

MIT
