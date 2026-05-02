---
title: "Memory"
sidebarTitle: "Memory"
description: "Memory persistence, embedding generation, vector search, memory types, and the retrieval API."
---

Eliza's memory system is backed by `@elizaos/plugin-sql` for persistence and `@elizaos/plugin-local-embedding` for vector embeddings. This page covers the memory infrastructure from the runtime perspective.

## Memory Architecture

```
User Message
    ↓
Memory Manager (via AgentRuntime)
    ↓
plugin-sql (PGLite / PostgreSQL)
    ↓
plugin-local-embedding (vector embeddings via node-llama-cpp)
    ↓
Memory retrieval → injected into context
```

## Database Backend

### PGLite (default)

PGLite is an embedded WebAssembly build of PostgreSQL that runs in the Node.js process with no external database server required. Eliza configures the data directory via `PGLITE_DATA_DIR`:

```
Default: ~/.eliza/workspace/.eliza/.elizadb
```

The directory is created on startup if it does not exist. After `adapter.init()`, Eliza performs a health check:

```typescript
const files = await fs.readdir(pgliteDataDir);
if (files.length === 0) {
  logger.warn("PGlite data directory is empty after init — data may not persist");
}
```

### PGLite Corruption Recovery

If PGLite initialization fails with a recoverable error (WASM abort or migrations schema error), Eliza backs up the existing data directory and retries:

```typescript
// Back up: <dataDir>.corrupt-<timestamp>
// Then recreate the directory and retry init
```

This prevents startup failures from persisting corrupted PGLite state.

### PostgreSQL

For production or shared deployments, set `database.provider = "postgres"`. The connection string is built from `database.postgres.*` fields and set as `POSTGRES_URL`.

## Embedding Model

`@elizaos/plugin-local-embedding` is pre-registered before `runtime.initialize()` to ensure its `TEXT_EMBEDDING` handler (priority 10) wins over any cloud provider's handler (priority 0).

### Default Model

```
nomic-embed-text-v1.5.Q5_K_M.gguf
Dimensions: 768
Model directory: ~/.eliza/models/
```

### Environment Variables

The embedding plugin reads configuration from environment variables set by `configureLocalEmbeddingPlugin()`:

| Variable | Default | Description |
|---|---|---|
| `LOCAL_EMBEDDING_MODEL` | `nomic-embed-text-v1.5.Q5_K_M.gguf` | GGUF model filename |
| `LOCAL_EMBEDDING_MODEL_REPO` | auto | Hugging Face repo for download |
| `LOCAL_EMBEDDING_DIMENSIONS` | auto | Embedding vector dimensions |
| `LOCAL_EMBEDDING_CONTEXT_SIZE` | auto | Context window size |
| `LOCAL_EMBEDDING_GPU_LAYERS` | `"auto"` (Apple Silicon) / `"0"` (other) | GPU acceleration |
| `LOCAL_EMBEDDING_USE_MMAP` | `"false"` (Apple Silicon) / `"true"` (other) | Memory-mapped model loading |
| `MODELS_DIR` | `~/.eliza/models` | Directory for model storage |

## Memory Config

The `MemoryConfig` type selects the memory backend:

```typescript
export type MemoryConfig = {
  backend?: "builtin" | "qmd";
  citations?: "auto" | "on" | "off";
  qmd?: MemoryQmdConfig;
};
```

### Built-in Backend

The default backend uses elizaOS core memory via `plugin-sql`. Configure under `eliza.json`:

```json
{
  "memory": {
    "backend": "builtin",
    "citations": "auto"
  }
}
```

### QMD Backend

The Quantum Memory Daemon backend supports indexing external file paths:

```json
{
  "memory": {
    "backend": "qmd",
    "qmd": {
      "command": "qmd",
      "includeDefaultMemory": true,
      "paths": [
        { "path": "~/notes", "name": "notes", "pattern": "**/*.md" },
        { "path": "~/projects/docs", "name": "project-docs" }
      ],
      "sessions": {
        "enabled": true,
        "exportDir": "~/.eliza/sessions",
        "retentionDays": 30
      },
      "update": {
        "interval": "30m",
        "onBoot": true,
        "debounceMs": 5000
      },
      "limits": {
        "maxResults": 20,
        "maxSnippetChars": 500,
        "maxInjectedChars": 4000,
        "timeoutMs": 3000
      }
    }
  }
}
```

## Vector Memory Search

The `MemorySearchConfig` controls vector similarity search. Set globally at `agents.defaults.memorySearch` or per-agent at `agents.list[n].memorySearch`:

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "enabled": true,
        "sources": ["memory"],
        "provider": "local",
        "store": {
          "driver": "sqlite",
          "path": "~/.eliza/memory-search.db",
          "vector": {
            "enabled": true,
            "extensionPath": null
          },
          "cache": {
            "enabled": true,
            "maxEntries": 10000
          }
        },
        "chunking": {
          "tokens": 512,
          "overlap": 64
        },
        "query": {
          "maxResults": 10,
          "minScore": 0.7,
          "hybrid": {
            "enabled": true,
            "vectorWeight": 0.6,
            "textWeight": 0.4,
            "candidateMultiplier": 4
          }
        },
        "sync": {
          "onSessionStart": true,
          "onSearch": false,
          "watch": false,
          "intervalMinutes": 60
        }
      }
    }
  }
}
```

### Search Sources

| Source | Description |
|---|---|
| `"memory"` | Agent's persistent memory store (default) |
| `"sessions"` | Session transcript indexing (experimental; enable via `experimental.sessionMemory: true`) |

### Embedding Providers

| Value | Description |
|---|---|
| `"local"` | node-llama-cpp local model (default) |
| `"openai"` | OpenAI Embeddings API |
| `"gemini"` | Google Gemini Embeddings API |

### Fallback Chain

When the primary embedding provider fails:

```json
{
  "memorySearch": {
    "fallback": "local"
  }
}
```

Accepted values: `"openai"`, `"gemini"`, `"local"`, `"none"`.

### Extra Knowledge Paths

Index additional directories or Markdown files alongside memory:

```json
{
  "memorySearch": {
    "extraPaths": [
      "~/notes/important",
      "~/projects/README.md"
    ]
  }
}
```

## Memory Pruning and Compaction

When context approaches token limits, Eliza can prune old tool results:

```json
{
  "agents": {
    "defaults": {
      "contextPruning": {
        "mode": "cache-ttl",
        "ttl": "30m",
        "keepLastAssistants": 3,
        "softTrimRatio": 0.3,
        "hardClearRatio": 0.7,
        "minPrunableToolChars": 500,
        "tools": {
          "allow": ["web_search", "browser"],
          "deny": ["memory_search"]
        }
      }
    }
  }
}
```

Context compaction (summarisation of older history) is handled by elizaOS core auto-compaction in the recent-messages provider.

## Knowledge Plugin

`knowledge` provides RAG knowledge management. It loads on startup as a core plugin and integrates with the memory store to retrieve knowledge chunks by vector similarity on every relevant turn.

## Related Pages

- [Memory and State](/agents/memory-and-state) — agent-level memory config
- [Core Runtime](/runtime/core) — pre-registration order and database initialization
- [Models](/runtime/models) — model provider configuration for embeddings
