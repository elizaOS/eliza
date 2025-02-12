---
sidebar_position: 14
---

# 🏗️ Infrastructure Guide

## Overview

Eliza's infrastructure is built on a flexible database architecture that supports multiple adapters and efficient data storage mechanisms for AI agent interactions, memory management, and relationship tracking.

## Core Components

### Database Adapters

Eliza supports multiple database backends through a pluggable adapter system:

- **PostgreSQL** - Full-featured adapter with vector search capabilities
- **SQLite** - Lightweight local database option
- **SQL.js** - In-memory database for testing and development
- **Supabase** - Cloud-hosted PostgreSQL with additional features

### Schema Structure

The database schema includes several key tables:

```sql
- accounts: User and agent identities
- rooms: Conversation spaces
- memories: Vector-indexed message storage
- goals: Agent objectives and progress
- participants: Room membership tracking
- relationships: Inter-agent connections
```

## Setting Up Infrastructure

### PostgreSQL Setup

1. **Install PostgreSQL Extensions**

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

2. **Initialize Core Tables**

```sql
-- Create base tables
CREATE TABLE accounts (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT,
    "username" TEXT UNIQUE,
    "email" TEXT NOT NULL UNIQUE,
    "avatarUrl" TEXT,
    "details" JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE rooms (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE memories (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "content" JSONB NOT NULL,
    "embedding" vector(1536),
    "userId" UUID REFERENCES accounts("id"),
    "agentId" UUID REFERENCES accounts("id"),
    "roomId" UUID REFERENCES rooms("id"),
    "isUnique" BOOLEAN DEFAULT true NOT NULL
);

CREATE TABLE participants (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" UUID REFERENCES accounts("id"),
    "roomId" UUID REFERENCES rooms("id"),
    "joinedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

3. **Set Up Indexes**

```sql
CREATE INDEX idx_memories_embedding ON memories
    USING hnsw ("embedding" vector_cosine_ops);

CREATE INDEX idx_memories_type_room ON memories("type", "roomId");

CREATE INDEX idx_participants_user ON participants("userId");
CREATE INDEX idx_participants_room ON participants("roomId");

```

### Connection Configuration

```typescript
// PostgreSQL Configuration
const postgresConfig = {
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
};

// Supabase Configuration
const supabaseConfig = {
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_KEY,
};
```

## Memory Management

### Vector Storage

The memory system uses vector embeddings for semantic search:

```typescript
import { embed } from "@elizaos/core";

async function storeMemory(runtime: IAgentRuntime, content: string) {
    const embedding = await embed(runtime, message.content.text);

    await runtime.databaseAdapter.createMemory({
        type: "message",
        content: { text: content },
        embedding,
        roomId: roomId,
        userId: userId,
    });
}
```

### Memory Retrieval

```typescript
import { embed } from "@elizaos/core";

async function searchMemories(runtime: IAgentRuntime, query: string) {
    const embedding = await embed(runtime, query);

    return runtime.databaseAdapter.searchMemoriesByEmbedding(embedding, {
        match_threshold: 0.8,
        count: 10,
        tableName: "memories",
    });
}
```

## Scaling Considerations

### Database Optimization

1. **Index Management**

    - Use HNSW indexes for vector similarity search
    - Create appropriate indexes for frequent query patterns
    - Regularly analyze and update index statistics

2. **Connection Pooling**

    ```typescript
    const pool = new Pool({
        max: 20, // Maximum pool size
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    });
    ```

3. **Query Optimization**
    - Use prepared statements
    - Implement efficient pagination
    - Optimize vector similarity searches

### High Availability

1. **Database Replication**

    - Set up read replicas for scaling read operations
    - Configure streaming replication for failover
    - Implement connection retry logic

2. **Backup Strategy**

    ```sql
    -- Regular backups
    pg_dump -Fc mydb > backup.dump

    -- Point-in-time recovery
    pg_basebackup -D backup -Fp -Xs -P
    ```

## Security

### Access Control

1. **Row Level Security**

```sql
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memories_isolation" ON memories
    USING (auth.uid() = "userId" OR auth.uid() = "agentId");
```

2. **Role Management**

```sql
-- Create application role
CREATE ROLE app_user;

-- Grant necessary permissions
GRANT SELECT, INSERT ON memories TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
```

### Data Protection

1. **Encryption**

    - Use TLS for connections
    - Encrypt sensitive data at rest
    - Implement key rotation

2. **Audit Logging**

```sql
CREATE TABLE logs (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "userId" UUID NOT NULL REFERENCES accounts("id"),
    "body" JSONB NOT NULL,
    "type" TEXT NOT NULL,
    "roomId" UUID NOT NULL REFERENCES rooms("id")
);
```

## Monitoring

### Health Checks

```typescript
async function checkDatabaseHealth(): Promise<boolean> {
    try {
        await db.query("SELECT 1");
        return true;
    } catch (error) {
        console.error("Database health check failed:", error);
        return false;
    }
}
```

### Performance Metrics

Track key metrics:

- Query performance
- Connection pool utilization
- Memory usage
- Vector search latency

## Maintenance

### Regular Tasks

1. **Vacuum Operations**

```sql
-- Regular vacuum
VACUUM ANALYZE memories;

-- Analyze statistics
ANALYZE memories;
```

2. **Index Maintenance**

```sql
-- Reindex vector similarity index
REINDEX INDEX idx_memories_embedding;
```

### Data Lifecycle

1. **Archival Strategy**

    - Archive old conversations
    - Compress inactive memories
    - Implement data retention policies

2. **Cleanup Jobs**

```typescript
async function cleanupOldMemories() {
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - 6);

    await db.query(
        `
        DELETE FROM memories 
        WHERE "createdAt" < $1
    `,
        [cutoffDate],
    );
}
```

## Troubleshooting

### Common Issues

1. **Connection Problems**

    - Check connection pool settings
    - Verify network connectivity
    - Review firewall rules

2. **Performance Issues**

    - Analyze query plans
    - Check index usage
    - Monitor resource utilization

3. **Vector Search Problems**
    - Verify embedding dimensions
    - Check similarity thresholds
    - Review index configuration

### Diagnostic Queries

```sql
-- Check connection status
SELECT * FROM pg_stat_activity;

-- Analyze query performance
EXPLAIN ANALYZE
SELECT * FROM memories
WHERE embedding <-> $1 < 0.3
LIMIT 10;

-- Monitor index usage
SELECT schemaname, tablename, indexname, idx_scan
FROM pg_stat_user_indexes;
```

## Further Reading

- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
