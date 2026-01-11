# @elizaos/plugin-localdb

A simple, JSON-based local database adapter for elizaOS. Perfect for local development, testing, and lightweight deployments.

## Features

- **Zero Configuration**: No database setup required - just works out of the box
- **No Migrations**: Data is stored as plain JSON files - no schema migrations needed
- **Cross-Platform**: Works in both Node.js (file system) and browsers (localStorage)
- **Vector Search**: Built-in HNSW index for semantic similarity search
- **Same Interface**: Implements the standard `IDatabaseAdapter` interface

## Installation

```bash
bun add @elizaos/plugin-localdb
```

## Quick Start

### Node.js

```typescript
import { plugin } from "@elizaos/plugin-localdb";

// Add to your agent configuration
const agent = {
  plugins: [plugin],
  // ...
};
```

### Browser

```typescript
import { plugin } from "@elizaos/plugin-localdb";

// Add to your agent configuration
const agent = {
  plugins: [plugin],
  // ...
};
```

## Configuration

### Environment Variables

| Variable           | Description                             | Default   |
| ------------------ | --------------------------------------- | --------- |
| `LOCALDB_DATA_DIR` | Directory for data files (Node.js only) | `./data`  |
| `LOCALDB_PREFIX`   | localStorage key prefix (Browser only)  | `elizaos` |

## Data Storage

### Node.js (File System)

Data is stored as JSON files in a hierarchical directory structure:

```
data/
├── agents/
│   └── {uuid}.json
├── memories/
│   └── {uuid}.json
├── rooms/
│   └── {uuid}.json
├── entities/
│   └── {uuid}.json
├── worlds/
│   └── {uuid}.json
├── components/
│   └── {uuid}.json
├── relationships/
│   └── {uuid}.json
├── participants/
│   └── {uuid}.json
├── tasks/
│   └── {uuid}.json
├── cache/
│   └── {key}.json
├── logs/
│   └── {uuid}.json
└── vectors/
    └── hnsw_index.json
```

### Browser (localStorage)

Data is stored in localStorage with a key prefix:

```
elizaos:agents:{uuid}
elizaos:memories:{uuid}
elizaos:rooms:{uuid}
...
```

## Vector Search

The plugin includes a simple HNSW (Hierarchical Navigable Small World) implementation for vector similarity search. This enables:

- Semantic memory search
- Similar content retrieval
- Embedding-based queries

The HNSW index is automatically persisted and loaded with the database.

## API

### Creating an Adapter Manually

```typescript
import { LocalDatabaseAdapter, NodeStorage } from "@elizaos/plugin-localdb";

const storage = new NodeStorage("./my-data");
const adapter = new LocalDatabaseAdapter(storage, agentId);
await adapter.init();
```

### Browser Usage

```typescript
import { LocalDatabaseAdapter, BrowserStorage } from "@elizaos/plugin-localdb";

const storage = new BrowserStorage("my-prefix");
const adapter = new LocalDatabaseAdapter(storage, agentId);
await adapter.init();
```

## Comparison with plugin-sql

| Feature      | plugin-localdb     | plugin-sql                |
| ------------ | ------------------ | ------------------------- |
| Setup        | Zero configuration | Requires PostgreSQL       |
| Migrations   | Not needed         | Automatic with Drizzle    |
| Scalability  | Single process     | Multi-process/distributed |
| Performance  | Good for dev/small | Production-grade          |
| Dependencies | None               | PostgreSQL, Drizzle       |

## Use Cases

- ✅ Local development
- ✅ Testing and CI/CD
- ✅ Single-user applications
- ✅ Prototyping
- ✅ Offline-first apps
- ⚠️ Not recommended for production with heavy load
- ⚠️ Not recommended for multi-process deployments

## Multi-Language Support

This plugin is available in multiple languages:

- **TypeScript/JavaScript**: Full implementation (this package)
- **Python**: See `python/` directory
- **Rust**: See `rust/` directory

## License

MIT
