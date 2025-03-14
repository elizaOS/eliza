# 🔧 Database Adapters

## Overview

Database Adapters provide the persistence layer for Eliza, enabling storage and retrieval of memories, relationships, goals, and other core data. The system supports multiple database backends through a unified interface.

## Available Adapters

Eliza includes the following database adapters:

- **PostgreSQL Adapter** (`@eliza/adapter-postgres`) - Production-ready adapter for PostgreSQL databases
- **SQLite Adapter** (`@eliza/adapter-sqlite`) - Lightweight adapter for SQLite, perfect for development
- **SQL.js Adapter** (`@eliza/adapter-sqljs`) - In-memory SQLite adapter for testing
- **Supabase Adapter** (`@eliza/adapter-supabase`) - Cloud-native adapter for Supabase

## Installation

```bash
# PostgreSQL
pnpm add @eliza/adapter-postgres

# SQLite
pnpm add @eliza/adapter-sqlite

# SQL.js
pnpm add @eliza/adapter-sqljs

# Supabase
pnpm add @eliza/adapter-supabase
```

## Quick Start

### SQLite (Development)

```typescript
import { SqliteDatabaseAdapter } from "@eliza/adapter-sqlite";
import Database from "better-sqlite3";

const db = new SqliteDatabaseAdapter(new Database("./dev.db"));
```

### PostgreSQL (Production)

```typescript
import { PostgresDatabaseAdapter } from "@eliza/adapter-postgres";

const db = new PostgresDatabaseAdapter({
    connectionString: process.env.DATABASE_URL,
    // Optional connection pool settings
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});
```

### Supabase (Cloud)

```typescript
import { SupabaseDatabaseAdapter } from "@eliza/adapter-supabase";

const db = new SupabaseDatabaseAdapter(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_API_KEY,
);
```

## Core Concepts

### Memory Storage

Memories are the fundamental unit of storage in Eliza. They represent messages, documents, and other content with optional embeddings for semantic search.

```typescript
interface Memory {
    id: UUID;
    content: {
        text: string;
        attachments?: Attachment[];
    };
    embedding?: number[];
    userId: UUID;
    roomId: UUID;
    agentId: UUID;
    createdAt: number;
}
```

### Relationships

Relationships track connections between users and agents:

```typescript
interface Relationship {
    userA: UUID;
    userB: UUID;
    status: "FRIENDS" | "BLOCKED";
}
```

### Goals

Goals track objectives and their progress:

```typescript
interface Goal {
    id: UUID;
    roomId: UUID;
    userId: UUID;
    name: string;
    status: GoalStatus;
    objectives: Objective[];
}
```

## Common Operations

### Memory Management

```typescript
// Create a memory
await db.createMemory(
    {
        id: uuid(),
        content: { text: "Hello world" },
        userId: user.id,
        roomId: room.id,
        agentId: agent.id,
        createdAt: Date.now(),
    },
    "messages",
);

// Search memories by embedding
const similar = await db.searchMemoriesByEmbedding(embedding, {
    match_threshold: 0.8,
    count: 10,
    roomId: room.id,
});

// Get recent memories
const recent = await db.getMemories({
    roomId: room.id,
    count: 10,
    unique: true,
});
```

### Relationship Management

```typescript
// Create relationship
await db.createRelationship({
    userA: user1.id,
    userB: user2.id,
});

// Get relationships for user
const relationships = await db.getRelationships({
    userId: user.id,
});
```

### Goal Management

```typescript
// Create goal
await db.createGoal({
    id: uuid(),
    roomId: room.id,
    userId: user.id,
    name: "Complete task",
    status: "IN_PROGRESS",
    objectives: [],
});

// Get active goals
const goals = await db.getGoals({
    roomId: room.id,
    onlyInProgress: true,
});
```

## Vector Search

All adapters support vector similarity search for memory retrieval:

```typescript
// Search by embedding vector
const memories = await db.searchMemories({
  tableName: "memories",
  roomId: room.id,
  embedding: [0.1, 0.2, ...], // 1536-dimensional vector
  match_threshold: 0.8,
  match_count: 10,
  unique: true
});

// Get cached embeddings
const cached = await db.getCachedEmbeddings({
  query_table_name: "memories",
  query_threshold: 0.8,
  query_input: "search text",
  query_field_name: "content",
  query_field_sub_name: "text",
  query_match_count: 10
});
```

## Performance Optimization

### Connection Pooling (PostgreSQL)

```typescript
const db = new PostgresDatabaseAdapter({
    connectionString: process.env.DATABASE_URL,
    max: 20, // Maximum pool size
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});
```

### Memory Usage (SQLite)

```typescript
const db = new SqliteDatabaseAdapter(
    new Database("./dev.db", {
        memory: true, // In-memory database
        readonly: false,
        fileMustExist: false,
    }),
);
```

### Caching (All Adapters)

```typescript
// Enable memory caching
const memory = new MemoryManager({
    runtime,
    tableName: "messages",
    cacheSize: 1000,
    cacheTTL: 3600,
});
```

## Schema Management

### PostgreSQL Migrations

```sql
-- migrations/20240318103238_remote_schema.sql
CREATE TABLE memories (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  content JSONB NOT NULL,
  embedding vector(1536),
  "userId" UUID NOT NULL,
  "roomId" UUID NOT NULL,
  "agentId" UUID NOT NULL,
  "unique" BOOLEAN DEFAULT FALSE,
  "createdAt" TIMESTAMP NOT NULL
);
```

### SQLite Schema

```typescript
const sqliteTables = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB,
  userId TEXT NOT NULL,
  roomId TEXT NOT NULL,
  agentId TEXT NOT NULL,
  "unique" INTEGER DEFAULT 0,
  createdAt INTEGER NOT NULL
);
`;
```

## Error Handling

```typescript
try {
    await db.createMemory(memory);
} catch (error) {
    if (error.code === "SQLITE_CONSTRAINT") {
        // Handle unique constraint violation
    } else if (error.code === "23505") {
        // Handle Postgres unique violation
    } else {
        // Handle other errors
    }
}
```

## Extending Adapters

To create a custom adapter, implement the `DatabaseAdapter` interface:

```typescript
class CustomDatabaseAdapter extends DatabaseAdapter {
    async createMemory(memory: Memory, tableName: string): Promise<void> {
        // Custom implementation
    }

    async getMemories(params: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
    }): Promise<Memory[]> {
        // Custom implementation
    }

    // Implement other required methods...
}
```

## Best Practices

1. **Connection Management**

    - Use connection pooling for PostgreSQL
    - Close connections properly when using SQLite
    - Handle connection errors gracefully

2. **Vector Search**

    - Set appropriate match thresholds based on your use case
    - Index embedding columns for better performance
    - Cache frequently accessed embeddings

3. **Memory Management**

    - Implement cleanup strategies for old memories
    - Use unique flags to prevent duplicates
    - Consider partitioning large tables

4. **Error Handling**
    - Implement retries for transient failures
    - Log database errors with context
    - Use transactions for atomic operations

## Troubleshooting

### Common Issues

1. **Connection Timeouts**

```typescript
// Increase connection timeout
const db = new PostgresDatabaseAdapter({
    connectionTimeoutMillis: 5000,
});
```

2. **Memory Leaks**

```typescript
// Clean up old memories periodically
await db.removeAllMemories(roomId, tableName);
```

3. **Vector Search Performance**

```typescript
// Create appropriate indexes
CREATE INDEX embedding_idx ON memories
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
```

## Related Resources

- [Memory Manager Documentation](../packages/core)
- [Vector Search Guide](../packages/database-adapters)
- [Database Schema Reference](/api)
