# SQLite Adapter

A SQLite database adapter for ElizaOS that provides persistent storage capabilities with vector similarity search support. This adapter implements the `IDatabaseAdapter` interface and extends the `DatabaseAdapter` base class to provide a lightweight, file-based storage solution ideal for development and embedded environments.

## Features

- Full SQLite database implementation of ElizaOS database interface
- Vector similarity search via sqlite-vec extension
- JSON validation and foreign key constraints
- Built-in caching system
- Comprehensive transaction support with circuit breaker pattern
- Support for storing and retrieving:
  - Memory entries with embeddings
  - User accounts and relationships
  - Goals and objectives
  - Room and participant management
  - Knowledge base with RAG support
  - System logs and cache

## Installation

```bash
npm install @elizaos-plugins/adapter-sqlite
```

## Dependencies

- better-sqlite3 (v11.8.1)
- sqlite-vec (v0.1.6)
- whatwg-url (v7.1.0)

## Usage

```typescript
import sqlitePlugin from '@elizaos-plugins/adapter-sqlite';
import { IAgentRuntime } from '@elizaos/core';

// Initialize with ElizaOS runtime
function initializeAgent(runtime: IAgentRuntime) {
    runtime.use(sqlitePlugin);
}

// Or initialize directly
import Database from 'better-sqlite3';
import { SqliteDatabaseAdapter } from '@elizaos-plugins/adapter-sqlite';

const db = new Database('path/to/database.db');
const adapter = new SqliteDatabaseAdapter(db);
await adapter.init();
```

## Configuration

The adapter looks for the following configuration in your ElizaOS runtime:

- `SQLITE_FILE`: Path to the SQLite database file (default: `./data/db.sqlite`)

### Default Database Location

By default, the adapter creates a `data` directory in your project root and stores the database file there. Customize this by setting the `SQLITE_FILE` in your ElizaOS runtime configuration.

## Database Schema

The adapter creates and manages these tables with appropriate indexes and constraints:

- `accounts`: User account information with JSON details
- `memories`: Memory entries with BLOB embeddings and JSON content
- `goals`: Task tracking with JSON objectives
- `logs`: System event logging
- `participants`: Room participation management 
- `relationships`: User relationship tracking
- `rooms`: Conversation room management
- `cache`: Temporary data storage with JSON validation
- `knowledge`: RAG knowledge base with embedding support

Each table includes appropriate indexes and foreign key constraints. The complete schema is available in `sqliteTables.ts`.

## Vector Search

The adapter implements vector similarity search using `sqlite-vec` for efficient embedding comparisons:

```typescript
const memories = await adapter.searchMemories({
    tableName: "memories",
    roomId: "room-id",
    embedding: [/* vector */],
    match_threshold: 0.95,
    match_count: 10,
    unique: true
});
```

## FAQ

### How does vector similarity search work?

The adapter uses sqlite-vec to calculate L2 distances between embeddings stored as BLOB data. This enables efficient vector similarity searches for memory and knowledge retrieval.

### Can I use this adapter with other databases?

This adapter is specifically designed for SQLite and implements ElizaOS's IDatabaseAdapter interface. For other databases, use the appropriate adapter (MongoDB, PostgreSQL, etc.).

### How are embeddings stored?

Embeddings are stored as BLOB data in SQLite using Float32Array, with automatic conversion between formats as needed.

### Is there support for transactions?

Yes, the adapter implements the framework's circuit breaker pattern and transaction support through better-sqlite3.

### How does the caching system work?

The adapter provides a built-in caching system through the `cache` table with support for JSON validation and automatic timestamp management.

### Can I use this in production?

While the adapter is built on production-ready better-sqlite3, it's primarily designed for development and embedded environments. For production deployments, consider PostgreSQL or MongoDB adapters.

### How do I backup the database?

Use standard SQLite backup procedures - either file system backup of the .sqlite file when the database is not in use, or SQLite's online backup API.

### What embedding dimensions are supported?

The adapter supports any embedding dimension through BLOB storage, though the default configuration is optimized for 384-dimensional vectors commonly used by local models.
