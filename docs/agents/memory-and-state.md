---
title: "Memory and State"
sidebarTitle: "Memory & State"
description: "Memory types, state composition, vector search configuration, and embedding model setup for Eliza agents."
---

Eliza uses the elizaOS memory system backed by `@elizaos/plugin-sql` for persistence and `@elizaos/plugin-local-embedding` for vector embeddings. Memory is composed into agent state at each conversation turn.

## Memory Backend

The default backend is PGLite (embedded PostgreSQL). PostgreSQL can be configured for production deployments.

### PGLite (default)

PGLite stores data in a local directory. Eliza pins the data directory at startup:

```
Default path: ~/.eliza/workspace/.eliza/.elizadb
```

Configured via `eliza.json`:

```json
{
  "database": {
    "provider": "pglite",
    "pglite": {
      "dataDir": "~/.eliza/workspace/.eliza/.elizadb"
    }
  }
}
```

### PostgreSQL

For shared or production deployments:

```json
{
  "database": {
    "provider": "postgres",
    "postgres": {
      "host": "localhost",
      "port": 5432,
      "database": "eliza",
      "user": "postgres",
      "password": "secret",
      "ssl": false
    }
  }
}
```

A full `connectionString` can be used instead of individual fields:

```json
{
  "database": {
    "provider": "postgres",
    "postgres": {
      "connectionString": "postgresql://postgres:secret@localhost:5432/eliza"
    }
  }
}
```

## Embedding Model

`@elizaos/plugin-local-embedding` provides vector embeddings using a local GGUF model via `node-llama-cpp`. It is pre-registered before other plugins so its `TEXT_EMBEDDING` handler (priority 10) is available before services start.

### Default Model

```
nomic-embed-text-v1.5.Q5_K_M.gguf
```

Models are stored in `~/.eliza/models/` by default.

### Embedding Configuration

```json
{
  "embedding": {
    "model": "nomic-embed-text-v1.5.Q5_K_M.gguf",
    "modelRepo": "nomic-ai/nomic-embed-text-v1.5-GGUF",
    "dimensions": 768,
    "contextSize": 2048,
    "gpuLayers": "auto",
    "idleTimeoutMinutes": 30
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | `nomic-embed-text-v1.5.Q5_K_M.gguf` | GGUF model filename |
| `modelRepo` | string | auto | Hugging Face repo for model download |
| `dimensions` | number | 768 | Embedding vector dimensions |
| `contextSize` | number | model hint | Context window for the embedding model |
| `gpuLayers` | number \| "auto" \| "max" | `"auto"` on Apple Silicon, `0` elsewhere | GPU acceleration layers |
| `idleTimeoutMinutes` | number | 30 | Minutes before unloading model from memory; 0 = never |

On Apple Silicon, `mmap` is disabled by default to prevent model loading errors on Metal.

## Memory Search (Vector Search)

Eliza includes a configurable vector memory search system. Configuration lives under `agents.defaults.memorySearch` or per-agent in `agents.list[n].memorySearch`:

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
          "vector": { "enabled": true }
        },
        "query": {
          "maxResults": 10,
          "minScore": 0.7,
          "hybrid": {
            "enabled": true,
            "vectorWeight": 0.6,
            "textWeight": 0.4
          }
        },
        "chunking": {
          "tokens": 512,
          "overlap": 64
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
| `"sessions"` | Past session transcripts (experimental) |

### Hybrid Search

When `hybrid.enabled` is true, search results merge BM25 text relevance with vector similarity:

- `vectorWeight` — weight for cosine similarity (default 0.6)
- `textWeight` — weight for BM25 text match (default 0.4)
- `candidateMultiplier` — size of candidate pool before re-ranking (default 4)

### Embedding Providers for Search

| Provider | Description |
|---|---|
| `"local"` | Uses local GGUF model via node-llama-cpp |
| `"openai"` | OpenAI embeddings API |
| `"gemini"` | Google Gemini embeddings API |

## Memory Config Type

The `MemoryConfig` type controls the memory backend selection:

```typescript
export type MemoryConfig = {
  backend?: "builtin" | "qmd";
  citations?: "auto" | "on" | "off";
  qmd?: MemoryQmdConfig;
};
```

The `qmd` (Quantum Memory Daemon) backend is an alternative memory store supporting external indexed knowledge paths:

```json
{
  "memory": {
    "backend": "qmd",
    "qmd": {
      "paths": [
        { "path": "~/notes", "name": "personal-notes", "pattern": "**/*.md" }
      ],
      "sessions": {
        "enabled": true,
        "retentionDays": 30
      },
      "limits": {
        "maxResults": 20,
        "maxSnippetChars": 500,
        "maxInjectedChars": 4000
      }
    }
  }
}
```

## Compaction

When conversation context approaches token limits, the compaction system summarises older context. Configuration under `agents.defaults.compaction`:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "mode": "default",
        "reserveTokensFloor": 1000,
        "maxHistoryShare": 0.5,
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 2000
        }
      }
    }
  }
}
```

| Mode | Behaviour |
|---|---|
| `"default"` | Standard compaction via elizaOS core auto-compaction |
| `"safeguard"` | More aggressive pruning, caps history at `maxHistoryShare` of the context window |

## Context Pruning

Distinct from compaction, context pruning removes old tool results to reduce token usage during active conversations:

```json
{
  "agents": {
    "defaults": {
      "contextPruning": {
        "mode": "cache-ttl",
        "ttl": "30m",
        "keepLastAssistants": 3,
        "softTrimRatio": 0.3,
        "hardClearRatio": 0.7
      }
    }
  }
}
```

## Knowledge Integration

`knowledge` provides RAG (Retrieval-Augmented Generation) knowledge management. It is loaded as a core plugin and integrates with the memory system to inject relevant knowledge chunks into agent context based on vector similarity.

## Related Pages

- [Runtime Memory Reference](/runtime/memory) — MemoryManager interface and retrieval API
- [Character Interface](./character-interface) — how the Character is assembled
- [Runtime and Lifecycle](./runtime-and-lifecycle) — when memory is initialized
