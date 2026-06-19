# @elizaos/plugin-inmemorydb

A pure in-memory, ephemeral database adapter for elizaOS. All data is completely lost on process restart or when `close()` is called.

Intended for tests, stateless deployments, prototyping, and scenarios where zero setup and zero persistence are the goal. Not suitable for production agents that need to remember past interactions.

## Installation

```bash
bun add @elizaos/plugin-inmemorydb
```

## Quick Start

```typescript
import { plugin } from "@elizaos/plugin-inmemorydb";

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
// Clear all data (adapter still usable after re-init)
await storage.clear();

// Or close the adapter entirely (also clears data)
await adapter.close();
```

## How It Works

The plugin uses JavaScript `Map` data structures to store all data, organized into named collections (agents, entities, memories, rooms, worlds, components, relationships, participants, tasks, cache, logs, embeddings, pairing_requests, pairing_allowlist). It also includes an ephemeral HNSW vector index for semantic similarity search.

When the process ends or `close()` is called, all collections are cleared and data is gone.

## Cross-Platform

Works in Node.js and browsers. The package `exports` map selects the correct build automatically (`dist/node/` for Node/Bun, `dist/browser/` for browsers).
