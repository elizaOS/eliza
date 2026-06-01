# @elizaos/plugin-localdb

Persistent local database adapter for elizaOS. Stores agent state to a JSON file on Node.js or to `localStorage` in the browser. No external database required.

## What it does

elizaOS agents need a `DatabaseAdapter` to store memories, entities, rooms, relationships, tasks, and other runtime state. This plugin provides that adapter with local persistence:

- **Node.js:** all collections are written to a single `localdb.json` file. Data survives process restarts.
- **Browser:** all collections are written to `localStorage` under the key `elizaos:localdb:<agentId>`.

Vector search uses an in-memory HNSW index (cosine similarity). The index is rebuilt from embeddings written during the current session; it does not persist across restarts.

## Capabilities added to an Eliza agent

- Full `IDatabaseAdapter` implementation: entities, memories (with vector search), rooms, worlds, components, relationships, participants, tasks, logs, cache, pairing requests.
- JSON-patch operations on component data (`set`, `remove`, `push`, `increment`).
- Levenshtein-based embedding cache lookup for deduplication.

## Installation

```bash
npm install @elizaos/plugin-localdb
```

Add the plugin to your agent character:

```ts
import localdbPlugin from "@elizaos/plugin-localdb";

const character = {
  plugins: [localdbPlugin],
  // ...
};
```

The plugin registers itself only if no other database adapter has already been loaded. Load order matters — place it after any preferred adapter so it acts as a fallback, or first if it is the intended adapter.

## Configuration

| Environment variable | Default | Description |
|----------------------|---------|-------------|
| `LOCALDB_DATA_DIR` | `.eliza-localdb/` (process cwd) | Directory where `localdb.json` is written. Also readable as an agent setting under the same key. |

The browser entry ignores all env vars and uses `localStorage` automatically.

## Limitations

- **Not for high write throughput.** The file backend flushes the entire JSON document after every write.
- **Vector index is not persisted.** Semantic memory search is unavailable for data written in previous sessions until new embeddings are stored.
- **No transaction atomicity.** Concurrent writes in a single process are not isolated.
- **Designed for development and lightweight deployments.** For production agents with large memory stores, prefer a SQL-backed adapter.
