# @elizaos/plugin-inmemorydb

A pure in-memory, ephemeral database adapter for elizaOS. All data is completely lost on process restart or when `close()` is called.

Intended for tests, stateless deployments, prototyping, and scenarios where zero setup and zero persistence are the goal. Not suitable for production agents that need to remember past interactions.

Custom `IStorage` implementations must provide `applyBatch` to support document
updates. The adapter fails closed when that primitive is absent because a
parent document and all fragments of its new revision must become visible
together. Replacement fragment IDs must be fresh and cannot reuse IDs from the
committed generation.

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

## Node runtime and isolated storage

This package runs in Node.js. Its root export retains the custom `IStorage` adapter and HNSW index. For the isolated, per-instance adapter formerly exported by core, use:

```typescript
import { InMemoryDatabaseAdapter } from "@elizaos/plugin-inmemorydb/runtime";
const adapter = new InMemoryDatabaseAdapter(agentId);
```

Supply this adapter to `AgentRuntime` explicitly. Core has no automatic in-memory fallback. The isolated adapter and the root shared-storage adapter have different constructors and storage contracts.

## Conditional embedding persistence

Background embedding results use `updateMemoryEmbedding({id, expected, embedding})`.
The adapter must atomically compare the stored source text, agent, author and room
with `expected` before writing. A changed or deleted source returns `false` and
receives no vector or completion event; database failures throw. Custom database
adapters must implement this contract when upgrading core. A separate read followed
by an unconditional update is insufficient. Vector-only runtime writes retain the
existing reconciliation-lease bypass and invalidate the room cache on success.
