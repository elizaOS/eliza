# PGLite Adapter for ElizaOS

## Purpose

A lightweight PostgreSQL-compatible database adapter for ElizaOS, providing vector search capabilities and efficient data persistence in a local environment.

## Key Features

- Embedded PostgreSQL engine for local development and testing
- Full vector search support via pgvector
- Built-in fuzzy string matching
- Automatic schema initialization
- Memory-efficient caching system
- Support for multiple embedding providers (OpenAI, Ollama, GaiaNet)
- Transaction support with automatic rollback

## Installation

```bash
bun install @elizaos-plugins/adapter-pglite
```

## Configuration

Add the adapter to your ElizaOS configuration:

```json
{
  "plugins": ["@elizaos-plugins/adapter-pglite"],
  "settings": {
    "PGLITE_DATA_DIR": "/path/to/data/directory" // Required setting
  }
}
```

### Required Environment Variables

- `PGLITE_DATA_DIR`: Path to the directory where PGLite will store its data
  - Use `memory://` for in-memory database (useful for testing)

## Integration

The adapter automatically configures vector search based on your embedding provider and manages database tables, vector indexes, cache tables, and relationship tracking tables.
