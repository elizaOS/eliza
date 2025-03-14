---
sidebar_position: 7
---

# 💾 Database Adapters

Database adapters provide persistent storage capabilities for ElizaOS agents. They handle memory storage, relationship tracking, and knowledge management across different database backends.

## Overview

Database adapters implement the [`IDatabaseAdapter`](/api/interfaces/IDatabaseAdapter) interface to provide consistent data access across different storage solutions. Each adapter optimizes for specific use cases:

| Adapter | Best For | Key Features |
|---------|----------|--------------|
| [MongoDB](https://github.com/elizaos-plugins/adapter-mongodb) | Production deployments | Sharding, vector search, real-time participant management |
| [PostgreSQL](https://github.com/elizaos-plugins/adapter-postgres) | Enterprise & vector search | Dynamic vector dimensions, fuzzy matching, comprehensive logging |
| [SQLite](https://github.com/elizaos-plugins/adapter-sqlite) | Development & embedded | Lightweight, file-based, vector BLOB support |
| [Supabase](https://github.com/elizaos-plugins/adapter-supabase) | Cloud-hosted vector DB | Multiple embedding sizes, real-time subscriptions, row-level security |
| [PGLite](https://github.com/elizaos-plugins/adapter-pglite) | Browser environments | Lightweight PostgreSQL implementation, HNSW indexing |
| [Qdrant](https://github.com/elizaos-plugins/adapter-qdrant) | Vector-focused deployments | Optimized for RAG applications, sophisticated preprocessing |
| [SQL.js](https://github.com/elizaos-plugins/adapter-sqljs) | Browser environments | Full SQLite functionality in browser, complex queries |

## Core Functionality

All adapters extend the [`DatabaseAdapter`](/api/classes/DatabaseAdapter) base class and implement the [`IDatabaseAdapter`](/api/interfaces/IDatabaseAdapter) interface. Here's a comprehensive overview of available methods:

| Category | Method | Description | Parameters |
|----------|---------|-------------|------------|
| **Database Lifecycle** |
| | `init()` | Initialize database connection | - |
| | `close()` | Close database connection | - |
| **Memory Management** |
| | `createMemory()` | Store new memory | `memory: Memory, tableName: string, unique?: boolean` |
| | `getMemoryById()` | Retrieve specific memory | `id: UUID` |
| | `getMemories()` | Get memories matching criteria | `{ roomId: UUID, count?: number, unique?: boolean, tableName: string, agentId: UUID, start?: number, end?: number }` |
| | `getMemoriesByIds()` | Get multiple memories by IDs | `memoryIds: UUID[], tableName?: string` |
| | `getMemoriesByRoomIds()` | Get memories from multiple rooms | `{ agentId: UUID, roomIds: UUID[], tableName: string, limit?: number }` |
| | `searchMemories()` | Search with vector similarity | `{ tableName: string, agentId: UUID, roomId: UUID, embedding: number[], match_threshold: number, match_count: number, unique: boolean }` |
| | `searchMemoriesByEmbedding()` | Search memories by embedding vector | `embedding: number[], { match_threshold?: number, count?: number, roomId?: UUID, agentId?: UUID, unique?: boolean, tableName: string }` |
| | `removeMemory()` | Remove specific memory | `memoryId: UUID, tableName: string` |
| | `removeAllMemories()` | Remove all memories in room | `roomId: UUID, tableName: string` |
| | `countMemories()` | Count memories in room | `roomId: UUID, unique?: boolean, tableName?: string` |
| **Knowledge Management** |
| | `createKnowledge()` | Store new knowledge item | `knowledge: RAGKnowledgeItem` |
| | `getKnowledge()` | Retrieve knowledge | `{ id?: UUID, agentId: UUID, limit?: number, query?: string, conversationContext?: string }` |
| | `searchKnowledge()` | Semantic knowledge search | `{ agentId: UUID, embedding: Float32Array, match_threshold: number, match_count: number, searchText?: string }` |
| | `removeKnowledge()` | Remove knowledge item | `id: UUID` |
| | `clearKnowledge()` | Remove all knowledge | `agentId: UUID, shared?: boolean` |
| **Room & Participants** |
| | `createRoom()` | Create new conversation room | `roomId?: UUID` |
| | `getRoom()` | Get room by ID | `roomId: UUID` |
| | `removeRoom()` | Remove room | `roomId: UUID` |
| | `addParticipant()` | Add user to room | `userId: UUID, roomId: UUID` |
| | `removeParticipant()` | Remove user from room | `userId: UUID, roomId: UUID` |
| | `getParticipantsForRoom()` | List room participants | `roomId: UUID` |
| | `getParticipantsForAccount()` | Get user's room participations | `userId: UUID` |
| | `getRoomsForParticipant()` | Get rooms for user | `userId: UUID` |
| | `getRoomsForParticipants()` | Get shared rooms for users | `userIds: UUID[]` |
| | `getParticipantUserState()` | Get participant's state | `roomId: UUID, userId: UUID` |
| | `setParticipantUserState()` | Update participant state | `roomId: UUID, userId: UUID, state: "FOLLOWED"|"MUTED"|null` |
| **Account Management** |
| | `createAccount()` | Create new user account | `account: Account` |
| | `getAccountById()` | Retrieve user account | `userId: UUID` |
| | `getActorDetails()` | Get actor information | `{ roomId: UUID }` |
| **Relationships** |
| | `createRelationship()` | Create user connection | `{ userA: UUID, userB: UUID }` |
| | `getRelationship()` | Get relationship details | `{ userA: UUID, userB: UUID }` |
| | `getRelationships()` | Get all relationships | `{ userId: UUID }` |
| **Goals** |
| | `createGoal()` | Create new goal | `goal: Goal` |
| | `updateGoal()` | Update goal | `goal: Goal` |
| | `updateGoalStatus()` | Update goal status | `{ goalId: UUID, status: GoalStatus }` |
| | `getGoals()` | Get goals matching criteria | `{ agentId: UUID, roomId: UUID, userId?: UUID, onlyInProgress?: boolean, count?: number }` |
| | `removeGoal()` | Remove specific goal | `goalId: UUID` |
| | `removeAllGoals()` | Remove all goals in room | `roomId: UUID` |
| **Caching & Embedding** |
| | `getCachedEmbeddings()` | Retrieve cached embeddings | `{ query_table_name: string, query_threshold: number, query_input: string, query_field_name: string, query_field_sub_name: string, query_match_count: number }` |
| **Logging** |
| | `log()` | Log event or action | `{ body: { [key: string]: unknown }, userId: UUID, roomId: UUID, type: string }` |

### Implementation Notes

Each adapter optimizes these methods for their specific database backend:

- **MongoDB**: Uses aggregation pipelines for vector operations
- **PostgreSQL**: Leverages pgvector extension
- **SQLite**: Implements BLOB storage for vectors
- **Qdrant**: Optimizes with HNSW indexing
- **Supabase**: Adds real-time capabilities

> Note: For detailed implementation examples, see each adapter's source repository (https://github.com/elizaos-plugins)

All adapters provide:

```typescript
interface IDatabaseAdapter {
    // Memory Management
    createMemory(memory: Memory, tableName: string): Promise<void>;
    getMemories(params: { roomId: UUID; count?: number }): Promise<Memory[]>;
    searchMemories(params: SearchParams): Promise<Memory[]>;
    removeMemory(memoryId: UUID): Promise<void>;
    
    // Account & Room Management
    createAccount(account: Account): Promise<boolean>;
    getAccountById(userId: UUID): Promise<Account>;
    createRoom(roomId?: UUID): Promise<UUID>;
    getRoom(roomId: UUID): Promise<UUID>;
    
    // Participant Management
    addParticipant(userId: UUID, roomId: UUID): Promise<boolean>;
    getParticipantsForRoom(roomId: UUID): Promise<UUID[]>;
    
    // Knowledge Management
    createKnowledge(knowledge: RAGKnowledgeItem): Promise<void>;
    searchKnowledge(params: SearchParams): Promise<RAGKnowledgeItem[]>;
    
    // Goal Management
    createGoal(goal: Goal): Promise<void>;
    updateGoalStatus(params: { goalId: UUID; status: GoalStatus }): Promise<void>;
}
```

<details>
<summary>Relationship Management</summary>
```typescript
interface IDatabaseAdapter {
    // Room Management
    createRoom(roomId?: UUID): Promise<UUID>;
    getRoom(roomId: UUID): Promise<UUID | null>;
    getRoomsForParticipant(userId: UUID): Promise<UUID[]>;
    
    // Participant Management
    addParticipant(userId: UUID, roomId: UUID): Promise<boolean>;
    getParticipantsForRoom(roomId: UUID): Promise<UUID[]>;
    getParticipantUserState(roomId: UUID, userId: UUID): Promise<"FOLLOWED" | "MUTED" | null>;
    
    // Relationship Tracking
    createRelationship(params: { userA: UUID; userB: UUID }): Promise<boolean>;
    getRelationship(params: { userA: UUID; userB: UUID }): Promise<Relationship | null>;
}
```
</details>

<details>
<summary>Cache & Goal Management</summary>
```typescript
interface IDatabaseCacheAdapter {
    getCache(params: {
        agentId: UUID;
        key: string;
    }): Promise<string | undefined>;
    
    setCache(params: {
        agentId: UUID;
        key: string;
        value: string;
    }): Promise<boolean>;
}

interface IDatabaseAdapter {
    // Goal Management
    createGoal(goal: Goal): Promise<void>;
    updateGoal(goal: Goal): Promise<void>;
    getGoals(params: {
        agentId: UUID;
        roomId: UUID;
        userId?: UUID | null;
        onlyInProgress?: boolean;
        count?: number;
    }): Promise<Goal[]>;
}
```
</details>

---

## Adapter Implementations

### Quick Start

```typescript
// MongoDB
import { MongoDBAdapter } from '@elizaos/adapter-mongodb';
const mongoAdapter = new MongoDBAdapter({
    uri: process.env.MONGODB_URI,
    dbName: process.env.MONGODB_DB_NAME
});

// PostgreSQL
import { PostgresAdapter } from '@elizaos/adapter-postgres';
const pgAdapter = new PostgresAdapter({
    connectionString: process.env.POSTGRES_URI
});

// SQLite
import { SqliteDatabaseAdapter } from '@elizaos/adapter-sqlite';
const sqliteAdapter = new SqliteDatabaseAdapter('path/to/database.db');

// Supabase
import { SupabaseAdapter } from '@elizaos/adapter-supabase';
const supabaseAdapter = new SupabaseAdapter({
    url: process.env.SUPABASE_URL,
    apiKey: process.env.SUPABASE_API_KEY
});
```

## Adapter Comparison

| Feature | MongoDB | PostgreSQL | SQLite | Supabase |
|---------|---------|------------|---------|-----------|
| **Best For** | Production deployments | Enterprise & vector search | Development & embedded | Cloud-hosted vector DB |
| **Vector Support** | Native sharding | Multiple dimensions (384d-1536d) | BLOB storage | Multi-dimension tables |
| **Key Features** | Auto-sharding, Real-time tracking, Auto-reconnection | Fuzzy matching, UUID keys, Comprehensive logging | JSON validation, FK constraints, Built-in caching | Real-time subs, Row-level security, Type-safe queries |
| **Setup Requirements** | None | pgvector extension | None | None |
| **Collections/Tables** | rooms, participants, accounts, memories, knowledge | Same as MongoDB + vector extensions | Same as MongoDB + metadata JSON | Same as PostgreSQL + dimension-specific tables |

## Implementation Details

### PostgreSQL Requirements
```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
```

### SQLite Schema
```sql
CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    type TEXT,
    content TEXT,
    embedding BLOB,
    userId TEXT FK,
    roomId TEXT FK,
    agentId TEXT FK
);

CREATE TABLE knowledge (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    embedding BLOB,
    metadata JSON
);
```

### Supabase Vector Tables
```sql
CREATE TABLE memories_1536 (id UUID PRIMARY KEY, embedding vector(1536));
CREATE TABLE memories_1024 (id UUID PRIMARY KEY, embedding vector(1024));
```

## Embedding Support

| Adapter | Supported Dimensions |
|---------|---------------------|
| MongoDB | All (as arrays) |
| PostgreSQL | OpenAI (1536d), Ollama (1024d), GAIANET (768d), BGE (384d) |
| SQLite | All (as BLOB) |
| Supabase | Configurable (384d-1536d) |

Source code: [elizaos-plugins](https://github.com/elizaos-plugins)

---

## Transaction & Error Handling

All adapters extend the [`DatabaseAdapter`](/api/classes/DatabaseAdapter) base class which provides built-in transaction support and error handling through the [`CircuitBreaker`](/api/classes/CircuitBreaker) pattern. See [database.ts](https://github.com/elizaos-plugins/core/blob/main/src/database.ts) for implementation details, as well as the [PostgreSQL Adapter Implementation](https://github.com/elizaos-plugins/adapter-postgres/blob/main/src/index.ts) or [SQLite Adapter Implementation](https://github.com/elizaos-plugins/adapter-sqlite/blob/main/src/index.ts) for detailed examples.

```typescript
// Transaction handling
const result = await adapter.withTransaction(async (client) => {
    await client.query("BEGIN");
    // Perform multiple operations
    await client.query("COMMIT");
    return result;
});

// Error handling with circuit breaker
protected async withCircuitBreaker<T>(
    operation: () => Promise<T>,
    context: string
): Promise<T> {
    try {
        return await this.circuitBreaker.execute(operation);
    } catch (error) {
        // Circuit breaker prevents cascading failures
        elizaLogger.error(`Circuit breaker error in ${context}:`, error);
        throw error;
    }
}
```

Implemented features include:
- Automatic rollback on errors
- Circuit breaker pattern to prevent cascading failures ([source](https://github.com/elizaOS/eliza/blob/main/packages/core/src/database/CircuitBreaker.ts))
- Connection pool management
- Error type classification

---

## FAQ

### How do I choose the right adapter?

Select based on your deployment needs. Use MongoDB/PostgreSQL for production, SQLite for development, SQL.js/PGLite for browser environments, and Qdrant/Supabase for vector-focused applications.

### Can I switch adapters later?

Yes, all adapters implement the [`IDatabaseAdapter`](/api/interfaces/IDatabaseAdapter) interface. Data migration between adapters is possible but requires additional steps.

### How are vector embeddings handled?

Each adapter implements vector storage based on its native capabilities - PostgreSQL/Supabase use native vector types, MongoDB uses array fields with indexes, SQLite uses BLOB storage, and Qdrant uses optimized vector stores.

### What about data migration?

Use the adapter's export/import methods defined in the [`DatabaseAdapter`](/api/classes/DatabaseAdapter) base class.

### How do I handle schema updates?

Run migrations using the adapter-specific CLI tools. Each adapter provides its own migration system - check the adapter's README in the [elizaos-plugins](https://github.com/elizaos-plugins) repository.

### How do I fix database connection issues?

Check your connection string format, verify the database exists and is accessible, ensure proper adapter configuration, and consider using environment variables for credentials.

### How do I resolve embedding dimension mismatch errors?

Set USE_OPENAI_EMBEDDING=TRUE in your .env file. Different models use different vector dimensions (e.g., OpenAI uses 1536, some local models use 384). Clear your database when switching embedding models.

### How do I clear/reset my database?

Delete the db.sqlite file in your data directory and restart the agent. For production databases, use proper database management tools for cleanup.

### Which database should I use in production?

PostgreSQL with vector extensions is recommended for production deployments. SQLite works well for development but may not scale as effectively for production loads.

### How do I migrate between different database adapters?

Use the export/import methods provided by the DatabaseAdapter base class. Each adapter implements these methods for data migration, though you may need to handle schema differences manually.

## Further Reading

- [Memory Management](../guides/memory-management.md)
- [State Management](./agents.md)
