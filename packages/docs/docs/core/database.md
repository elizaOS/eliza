---
sidebar_position: 7
---

# 💾 Database System

The ElizaOS database system provides persistent storage capabilities for agents. It handles memory storage, entity relationships, knowledge management, and more through a flexible adapter-based architecture.

## Overview

```mermaid
graph TB
    %% Main Components
    Runtime([Agent Runtime])
    DbAdapter([Database Adapter])
    DbConnection[("Database (PGLite/PostgreSQL)")]

    %% Data Models in compact form
    DataModels["Data Models: Entities, Components, Memories, Relationships, Rooms, Worlds, Tasks Cache"]

    %% Vector Search
    VectorStore[(Vector Store)]

    %% Memories Knowledge
    MemoriesKnowledge[(Memories / Knowledge)]

    %% Connection flow
    Runtime -->|Uses| DbAdapter
    DbAdapter -->|Connects to| DbConnection
    DbConnection -->|Stores & Retrieves| DataModels

    %% Connect Vector Store
    DbConnection -->|Utilizes| VectorStore
    VectorStore -->|Enables Search on| MemoriesKnowledge

    %% Styling
    classDef default fill:#f0f4f8,stroke:#2c3e50,stroke-width:1px;
    classDef runtime fill:#3498db,stroke:#2c3e50,stroke-width:1px,color:#fff;
    classDef adapter fill:#9b59b6,stroke:#2c3e50,stroke-width:1px,color:#fff;
    classDef db fill:#27ae60,stroke:#2c3e50,stroke-width:1px,color:#fff;
    classDef datamodels fill:#52be80,stroke:#2c3e50,stroke-width:1px,color:#fff;
    classDef memories fill:#2c5e1a,stroke:#2c3333,stroke-width:1px,color:#fff;

    class Runtime runtime;
    class DbAdapter adapter;
    class DbConnection,VectorStore db;
    class DataModels datamodels;
    class MemoriesKnowledge memories;
```

ElizaOS uses a unified database architecture based on Drizzle ORM with adapters that implement the [`IDatabaseAdapter`](/api/interfaces/IDatabaseAdapter) interface. The current release includes support for:

| Adapter        | Best For                    | Key Features                                                      |
| -------------- | --------------------------- | ----------------------------------------------------------------- |
| **PGLite**     | Local development & testing | Lightweight PostgreSQL implementation running in Node.js process  |
| **PostgreSQL** | Production deployments      | Full PostgreSQL with vector search, scaling, and high reliability |

Additional database adapters will be supported in future releases as ElizaOS continues to evolve.

## Core Functionality

All database adapters extend the `BaseDrizzleAdapter` abstract class, which provides a comprehensive set of methods for managing all aspects of agent data:

### Entity System

| Method                 | Description                           |
| ---------------------- | ------------------------------------- |
| `createEntity()`       | Create a new entity                   |
| `getEntityById()`      | Retrieve an entity by ID              |
| `getEntitiesForRoom()` | Get all entities in a room            |
| `updateEntity()`       | Update entity attributes              |
| `getComponent()`       | Get a specific component of an entity |
| `getComponents()`      | Get all components for an entity      |
| `createComponent()`    | Add a component to an entity          |
| `updateComponent()`    | Update a component                    |
| `deleteComponent()`    | Remove a component                    |

### Memory Management

| Method                        | Description                          |
| ----------------------------- | ------------------------------------ |
| `createMemory()`              | Store a new memory with metadata     |
| `getMemoryById()`             | Retrieve a specific memory           |
| `getMemories()`               | Get memories matching criteria       |
| `getMemoriesByIds()`          | Get multiple memories by IDs         |
| `getMemoriesByRoomIds()`      | Get memories from multiple rooms     |
| `searchMemories()`            | Search memories by vector similarity |
| `searchMemoriesByEmbedding()` | Search using raw embedding vector    |
| `deleteMemory()`              | Remove a specific memory             |
| `deleteAllMemories()`         | Remove all memories in a room        |
| `countMemories()`             | Count memories matching criteria     |

### Room & Participant Management

| Method                       | Description                     |
| ---------------------------- | ------------------------------- |
| `createRoom()`               | Create a new conversation room  |
| `getRoom()`                  | Get room by ID                  |
| `getRooms()`                 | Get all rooms in a world        |
| `updateRoom()`               | Update room attributes          |
| `deleteRoom()`               | Remove a room                   |
| `addParticipant()`           | Add entity to room              |
| `removeParticipant()`        | Remove entity from room         |
| `getParticipantsForEntity()` | Get all rooms an entity is in   |
| `getParticipantsForRoom()`   | List entities in a room         |
| `getParticipantUserState()`  | Get entity's state in a room    |
| `setParticipantUserState()`  | Update entity's state in a room |

### Relationship Management

| Method                 | Description                            |
| ---------------------- | -------------------------------------- |
| `createRelationship()` | Create a relationship between entities |
| `updateRelationship()` | Update relationship attributes         |
| `getRelationship()`    | Get a specific relationship            |
| `getRelationships()`   | Get all relationships for an entity    |

### Caching System

| Method          | Description            |
| --------------- | ---------------------- |
| `getCache()`    | Retrieve cached data   |
| `setCache()`    | Store data in cache    |
| `deleteCache()` | Remove data from cache |

### World & Task Management

| Method             | Description                 |
| ------------------ | --------------------------- |
| `createWorld()`    | Create a new world          |
| `getWorld()`       | Get world by ID             |
| `getAllWorlds()`   | List all worlds             |
| `updateWorld()`    | Update world attributes     |
| `removeWorld()`    | Delete a world              |
| `createTask()`     | Create a new task           |
| `getTasks()`       | Get tasks matching criteria |
| `getTasksByName()` | Find tasks by name          |
| `getTask()`        | Get task by ID              |
| `updateTask()`     | Update task attributes      |
| `deleteTask()`     | Remove a task               |

### Agent Management

| Method          | Description               |
| --------------- | ------------------------- |
| `createAgent()` | Create a new agent record |
| `getAgent()`    | Get agent by ID           |
| `getAgents()`   | List all agents           |
| `updateAgent()` | Update agent attributes   |
| `deleteAgent()` | Remove an agent           |
| `countAgents()` | Count total agents        |

### Embedding & Search

| Method                        | Description                    |
| ----------------------------- | ------------------------------ |
| `ensureEmbeddingDimension()`  | Configure embedding dimensions |
| `getCachedEmbeddings()`       | Retrieve cached embeddings     |
| `searchMemories()`            | Vector search for memories     |
| `searchMemoriesByEmbedding()` | Advanced vector search         |

## Architecture

ElizaOS uses a singleton pattern for database connections to ensure efficient resource usage:

```
┌─────────────────────────────────────┐
│           AgentRuntime              │
└───────────────┬─────────────────────┘
                │
                ▼
┌─────────────────────────────────────┐
│        IDatabaseAdapter             │
└───────────────┬─────────────────────┘
                │
                ▼
┌─────────────────────────────────────┐
│       BaseDrizzleAdapter            │
└───────────────┬─────────────────────┘
                │
        ┌───────┴───────┐
        ▼               ▼
┌───────────────┐ ┌─────────────────┐
│ PGLiteAdapter │ │ PostgresAdapter │
└───────┬───────┘ └────────┬────────┘
        │                  │
        ▼                  ▼
┌───────────────┐ ┌─────────────────┐
│PGLiteManager  │ │PostgresManager  │
│  (Singleton)  │ │  (Singleton)    │
└───────────────┘ └─────────────────┘
```

Each adapter is associated with a singleton connection manager that ensures only one database connection is maintained per process, regardless of how many agents are running.

## Implementation

### Initialization

The database adapter is initialized through the SQL plugin:

```typescript
// Plugin registration in project configuration
const project = {
  plugins: ['@elizaos/plugin-sql'],
  // ...
};
```

The SQL plugin automatically selects and initializes the appropriate database adapter based on environment settings:

```typescript
function createDatabaseAdapter(
  config: {
    dataDir?: string;
    postgresUrl?: string;
  },
  agentId: UUID
): IDatabaseAdapter {
  if (config.postgresUrl) {
    return new PgDatabaseAdapter(agentId, postgresConnectionManager);
  }

  // Default to PGLite
  return new PgliteDatabaseAdapter(agentId, pgLiteClientManager);
}
```

### Configuration

Configure the database adapter using environment variables or settings:

```typescript
// For PostgreSQL
process.env.POSTGRES_URL = 'postgresql://username:password@localhost:5432/elizaos';

// For PGLite (default)
process.env.PGLITE_DATA_DIR = './elizadb'; // Optional, defaults to './pglite'
```

### Retry Logic & Error Handling

The database system includes built-in retry logic with exponential backoff and jitter:

```typescript
protected async withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < this.maxRetries) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      const isRetryable = this.isRetryableError(error);

      if (!isRetryable) {
        break;
      }

      // Calculate delay with exponential backoff and jitter
      const delay = Math.min(
        this.baseDelay * Math.pow(2, attempt) + Math.random() * this.jitterMax,
        this.maxDelay
      );

      await new Promise(resolve => setTimeout(resolve, delay));
      attempt++;
    }
  }

  throw lastError;
}
```

## Example Usage

Here are examples of common database operations:

### Store a Memory

```typescript
await runtime.createMemory(
  {
    entityId: message.entityId,
    agentId: runtime.agentId,
    content: { text: 'Important information to remember' },
    roomId: message.roomId,
    embedding: await runtime.useModel(ModelType.TEXT_EMBEDDING, {
      text: 'Important information to remember',
    }),
  },
  'facts'
);
```

### Search for Memories

```typescript
const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
  text: 'What did we discuss about databases?',
});

const relevantMemories = await runtime.searchMemories({
  tableName: 'messages',
  embedding,
  roomId: message.roomId,
  count: 5,
});
```

### Manage Entity Relationships

```typescript
// Create a relationship between entities
await runtime.createRelationship({
  sourceEntityId: userEntityId,
  targetEntityId: agentEntityId,
  tags: ['friend', 'frequent_interaction'],
  metadata: {
    interactions: 42,
    trust_level: 'high',
  },
});

// Retrieve relationships
const relationships = await runtime.getRelationships({
  entityId: userEntityId,
  tags: ['friend'],
});
```

## Database Schema

The schema is managed by Drizzle ORM and includes the following key tables:

### Core Tables

- **entities**: The fundamental objects in the system (users, agents, etc.)
- **components**: Modular data attached to entities (profiles, settings, etc.)
- **memories**: Conversation history and other remembered information
- **relationships**: Connections between entities
- **rooms**: Conversation channels
- **participants**: Entity participation in rooms
- **worlds**: Container for multiple rooms
- **tasks**: Scheduled or queued operations
- **cache**: Temporary key-value storage
- **agents**: Agent configuration and state

### Entity-Component System

ElizaOS uses an entity-component architecture where:

- Entities are the base objects (users, agents, etc.)
- Components are pieces of data attached to entities
- This allows for flexible data modeling and extension

For example, a user entity might have profile, preferences, and authentication components.

## Vector Search

Both adapters support vector-based semantic search with some differences:

- **PostgreSQL**: Uses pgvector extension for optimized vector operations
- **PGLite**: Implements vector search in JavaScript with an efficient algorithm

The embedding dimension is configurable based on the model used:

```typescript
await adapter.ensureEmbeddingDimension(1536); // For OpenAI embeddings
```

## FAQ

### How do I choose between PGLite and PostgreSQL?

- Use **PGLite** for:

  - Local development and testing
  - Single-user deployments
  - Situations where installing PostgreSQL is impractical

- Use **PostgreSQL** for:
  - Production deployments
  - Multi-user systems
  - High-volume data
  - When you need advanced scaling features

### How do I configure the database connection?

For PostgreSQL, set the `POSTGRES_URL` environment variable:

```
POSTGRES_URL=postgresql://username:password@localhost:5432/elizaos
```

For PGLite, set the data directory (optional):

```
PGLITE_DATA_DIR=./my-data
```

### How can I inspect the database contents?

For PostgreSQL, use standard PostgreSQL tools like pgAdmin or psql.

For PGLite, the data is stored in the specified data directory as files. You can use tools like DB Browser for SQLite to inspect the SQLite files that PGLite generates.

### How do I migrate between different database adapters?

Currently, there's no built-in migration tool between adapters. For production systems, it's recommended to start with PostgreSQL if you anticipate needing its features.

### What about vector embedding dimension mismatches?

The system automatically handles embedding dimensions based on the model used. If you change embedding models, make sure to:

1. Set the correct dimension with `ensureEmbeddingDimension()`
2. Be aware that mixing different dimensions in the same database can cause issues

### How does the entity-component system work?

The entity-component system (ECS) provides a flexible way to model data:

- **Entities** are base objects with unique IDs
- **Components** are pieces of data attached to entities
- This allows for dynamic composition of objects without complex inheritance

For example, a user entity might have profile, preferences, and authentication components.

### How can I improve database performance?

- For **PostgreSQL**:

  - Ensure the pgvector extension is properly installed
  - Index frequently queried fields
  - Use connection pooling
  - Consider partitioning for large datasets

- For **PGLite**:
  - Keep database size reasonable (under 1GB)
  - Regularly clean up old memories
  - Limit the number of concurrent operations

### Will other database adapters be supported in the future?

Yes, future releases will add support for additional databases such as:

- MongoDB
- SQLite
- Supabase
- Qdrant
- SQL.js

The adapter interface is designed to be extensible to support a wide range of storage solutions.

## Further Reading

- [Entity System](./entities.md)
- [Agent Runtime](./agents.md)
