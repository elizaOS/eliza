---
title: "Knowledge"
sidebarTitle: "Knowledge"
description: "Native RAG system — document ingestion, embedding generation, similarity search, knowledge retrieval, and supported file formats."
---

<Warning>
Character Knowledge is a built-in documents runtime capability, not a standalone plugin. No separate installation is needed — documents features are available by default.
</Warning>

The native documents feature provides a Retrieval-Augmented Generation (RAG) system for Eliza agents. It enables agents to retrieve relevant information from a document corpus and inject it into the LLM context.

**Built-in runtime feature** — `documents` is part of the elizaOS core runtime and is enabled by default. It is not a standalone plugin in the plugin registry; it loads automatically as part of the core plugin set.

## Overview

The documents feature manages the full RAG pipeline:

1. **Ingest** — Documents are chunked and embedded on upload
2. **Index** — Embeddings are stored in the vector store (backed by the SQL plugin)
3. **Retrieve** — At inference time, the query is embedded and similar chunks are retrieved
4. **Inject** — Retrieved chunks are injected into the agent prompt as context

## Installation

Character Knowledge is enabled automatically in Eliza. No installation is required.

## Supported File Formats

| Format | Description |
|--------|-------------|
| `.txt` | Plain text |
| `.md` | Markdown |
| `.pdf` | PDF documents (via `@elizaos/plugin-pdf`) |
| `.json` | JSON data |
| `.csv` | Comma-separated values |
| `.html` | HTML pages (stripped to text) |

## Adding Knowledge

### Via the Admin Panel

Navigate to **Agent → Knowledge** and upload documents through the file picker.

### Via the REST API

```bash
curl -X POST http://localhost:31337/api/documents \
  -H "Authorization: Bearer $ELIZA_API_KEY" \
  -F "file=@document.pdf" \
  -F "agentId=your-agent-id"
```

### Via Configuration

Place documents in the documents directory specified in `eliza.json`:

```json
{
  "documents": {
    "directory": "./documents",
    "autoIngest": true
  }
}
```

### Via Character File

```json
{
  "name": "MyAgent",
  "documents": [
    "This agent specializes in TypeScript and Node.js development.",
    "The project uses elizaOS core version 2.x.",
    { "path": "./docs/api-reference.md" }
  ]
}
```

Existing character files that still contain `knowledge` are imported into documents on load.

## Retrieval Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `documents.topK` | Number of chunks to retrieve per query | `5` |
| `documents.minScore` | Minimum similarity score (0–1) | `0.7` |
| `documents.chunkSize` | Characters per chunk | `1000` |
| `documents.chunkOverlap` | Overlap between adjacent chunks | `200` |

```json
{
  "documents": {
    "topK": 5,
    "minScore": 0.7,
    "chunkSize": 1000,
    "chunkOverlap": 200
  }
}
```

## Embedding Model

By default, document embeddings use the local embedding model provided by `@elizaos/plugin-local-embedding` (Nomic Embed Text v1.5). Eliza caps the embedding dimension to **384** (set via `EMBEDDING_DIMENSION` at boot). This runs entirely on-device — no API key required.

To use a different embedding model, configure it in `eliza.json`:

```json
{
  "embedding": {
    "model": "nomic-embed-text-v1.5.Q5_K_M.gguf",
    "dimensions": 384
  }
}
```

## Documents Provider

At inference time, the documents provider:

1. Embeds the current user message
2. Searches the vector store for semantically similar chunks
3. Injects retrieved chunks into the prompt as a `# Knowledge` block

The provider runs early so relevant document snippets are available when the LLM generates its response.

```
# Knowledge

[Retrieved chunk 1]

[Retrieved chunk 2]

[Retrieved chunk 3]
```

## Actions

The native documents feature registers the following actions:

| Action | Description |
|--------|-------------|
| `DOCUMENT` | List, search, read, write, edit, delete, or import documents via sub-actions |

## Documents API

```typescript
// From any plugin with access to the runtime:
const service = runtime.getService("documents");
const results = await service.searchDocuments(message, undefined, "hybrid");
```

## Related

- [Cron Plugin](/plugin-registry/cron) — Triggers knowledge retrieval on a schedule
- [SQL Plugin](/plugin-registry/sql) — Vector store backend
- [Documents Guide](/guides/documents) — Detailed knowledge management guide
