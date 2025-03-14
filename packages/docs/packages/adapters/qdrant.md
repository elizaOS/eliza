# Qdrant Adapter for ElizaOS

A vector database adapter for ElizaOS that provides efficient similarity search capabilities through Qdrant, optimized for knowledge management and semantic search operations.

## Features

- Vector similarity search with cosine distance
- Efficient knowledge base management
- Built-in text preprocessing for better search quality
- UUID v5 compatibility for Qdrant IDs
- In-memory caching system
- Content metadata support
- Shared knowledge management

## Prerequisites

- Qdrant server (self-hosted or cloud)
- Node.js 23 or later
- ElizaOS installation

## Installation

```bash
npm install @elizaos-plugins/adapter-qdrant
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
    "QDRANT_VECTOR_SIZE": "1536"  // Adjust based on your embedding size
  }
}
```

### Required Environment Variables

- `QDRANT_URL`: URL of your Qdrant server
- `QDRANT_KEY`: API key for authentication
- `QDRANT_PORT`: Port number for Qdrant server
- `QDRANT_VECTOR_SIZE`: Dimension of your vectors

## Features in Detail

### Vector Search

The adapter provides specialized vector search capabilities:
- Cosine similarity search
- Configurable vector dimensions
- Support for multiple embedding types
- Cache support for frequent searches

### Knowledge Management

Knowledge items are stored with:
- Vector embeddings for similarity search
- Metadata support for additional information
- Shared/private knowledge separation
- Content versioning through chunk management

### Text Preprocessing

Built-in text preprocessing for better search quality:
- Code block removal
- URL normalization
- Markdown cleanup
- Special character handling
- Whitespace normalization

### Caching System

Efficient in-memory caching:
- Per-agent cache isolation
- UUID-based cache keys
- Automatic cache management

## Usage Notes

### Specialized Functions

This adapter primarily implements:
- Knowledge management
- Vector similarity search
- Caching operations

Other database functions (like memory management, participant tracking, etc.) are stubbed but not implemented. Use a different adapter if you need these features.

### Collection Management

The adapter automatically manages:
- Collection creation
- Vector indexes
- Point upserts with payload

### Best Practices

1. Set correct vector dimensions based on your embedding model
2. Use consistent embedding generation
3. Consider caching for frequent searches
4. Monitor memory usage with large cache sizes

## FAQ

### Can I use different vector sizes?

Yes, configure QDRANT_VECTOR_SIZE based on your embedding model's output size.

### Is caching required?

No, caching is optional but recommended for performance when doing repeated searches.

### Can I share knowledge between agents?

Yes, use the isShared flag in knowledge metadata for shared content.

### How do I handle different embedding models?

Configure the vector size to match your model's output dimensions and ensure consistent preprocessing.

### Does it support multi-tenancy?

Yes, through per-agent isolation of knowledge and cache.

### What about full-text search?

The adapter focuses on vector similarity search; use MongoDB or PostgreSQL adapters for full-text search.

### Is sharding supported?

Yes, through Qdrant's native sharding capabilities.
