# PGLite Adapter for ElizaOS

A lightweight PostgreSQL-compatible database adapter for ElizaOS, providing vector search capabilities and efficient data persistence in a local environment.

## Features

- Embedded PostgreSQL engine for local development and testing
- Full vector search support via pgvector
- Built-in fuzzy string matching
- Automatic schema initialization
- Memory-efficient caching system
- Support for multiple embedding providers (OpenAI, Ollama, GaiaNet)
- Transaction support with automatic rollback

## Prerequisites

- Node.js 16 or later
- ElizaOS installation
- Sufficient disk space for local database storage

## Installation

```bash
npm install @elizaos-plugins/adapter-pglite
```

## Configuration

Add the adapter to your ElizaOS configuration:

```json
{
  "plugins": ["@elizaos-plugins/adapter-pglite"],
  "settings": {
    "PGLITE_DATA_DIR": "/path/to/data/directory"  // Required setting
  }
}
```

### Required Environment Variables

- `PGLITE_DATA_DIR`: Path to the directory where PGLite will store its data
  - Use `memory://` for in-memory database (useful for testing)

## Features in Detail

### Vector Search

The adapter automatically configures vector search based on your embedding provider:

- OpenAI (1536 dimensions)
- Ollama (1024 dimensions)
- GaiaNet (768 dimensions)
- Default/Other (384 dimensions)

### Schema Management

The adapter automatically manages:

- Database tables (memories, participants, goals, etc.)
- Vector indexes for similarity search
- Cache tables with TTL support
- Relationship tracking tables

### Caching System

Built-in caching system features:

- Automatic cache invalidation
- Support for vector similarity caching
- Levenshtein distance-based text matching
- Transaction-safe cache updates

## Performance Considerations

- Uses optimized vector indexes for fast similarity searches
- Implements efficient batch processing for large datasets
- Automatic cleanup of expired cache entries
- Transaction support for data consistency

## FAQ

### Can I use this adapter in production?

PGLite is designed primarily for development and testing environments. For production use, consider using the full PostgreSQL adapter.

### How does the vector search compare to full PostgreSQL?

PGLite's vector search capabilities are identical to PostgreSQL when using pgvector, but with slightly lower performance due to its embedded nature.

### Can I migrate from PGLite to full PostgreSQL?

Yes, the schema and query structure are identical between PGLite and PostgreSQL, making migration straightforward.

### Does it support concurrent connections?

PGLite supports multiple connections but is optimized for single-process use. For heavy concurrent workloads, use the full PostgreSQL adapter.

### How large can the database grow?

PGLite is limited by available disk space and system memory. For datasets larger than a few GB, consider using the full PostgreSQL adapter.

### Can I use custom embedding dimensions?

Yes, the adapter automatically detects and configures the correct embedding dimensions based on your provider settings.

### Is the data persistent?

Yes, when using a file system path for PGLITE_DATA_DIR. Use memory:// for non-persistent, in-memory storage.

### How do I backup the database?

Simply copy the PGLITE_DATA_DIR directory. All database files are stored there.
