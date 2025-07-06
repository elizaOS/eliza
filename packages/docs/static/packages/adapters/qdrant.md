# Qdrant Adapter for ElizaOS

## Purpose

A vector database adapter for ElizaOS that provides efficient similarity search capabilities through Qdrant, optimized for knowledge management and semantic search operations.

## Key Features

- Vector similarity search with cosine distance
- Efficient knowledge base management
- Built-in text preprocessing for better search quality
- UUID v5 compatibility for Qdrant IDs
- In-memory caching system
- Content metadata support
- Shared knowledge management

## Installation

```bash
bun install @elizaos-plugins/adapter-qdrant
```

## Configuration

Add the adapter to your ElizaOS configuration:

```json
{
  "plugins": ["@elizaos-plugins/adapter-qdrant"],
  "settings": {
    "QDRANT_URL": "your-qdrant-server-url",
    "QDRANT_KEY": "your-qdrant-api-key",
    "QDRANT_PORT": "6333",
    "QDRANT_VECTOR_SIZE": "1536"
  }
}
```

### Required Environment Variables

- `QDRANT_URL`: URL of your Qdrant server
- `QDRANT_KEY`: API key for authentication
- `QDRANT_PORT`: Port number for Qdrant server
- `QDRANT_VECTOR_SIZE`: Dimension of your vectors

## Integration

The adapter implements knowledge management, vector similarity search, and caching operations for ElizaOS, while other database functions are stubbed but not implemented.
