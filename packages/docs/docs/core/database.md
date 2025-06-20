---
sidebar_position: 7
title: Database System
description: Understanding ElizaOS database system - persistent storage and data management for agents
keywords:
  [
    database,
    storage,
    adapters,
    PostgreSQL,
    PGLite,
    entities,
    memories,
    relationships,
    multi-tenant,
    embeddings,
  ]
image: /img/database.jpg
---

# 💾 Database System

The ElizaOS database system provides persistent storage capabilities for agents. It handles memory storage, entity relationships, knowledge management, and more through a flexible adapter-based architecture with built-in multi-tenancy support.

## Overview

```mermaid
graph TB
    %% Main Components
    Runtime([Agent Runtime])
    DbAdapter([Database Adapter])
    DbConnection[("Database (PGLite/PostgreSQL)")]

    %% Data Models in compact form
    DataModels["Data Models: Entities, Components, Memories, Relationships, Rooms, Worlds, Tasks, Cache"]

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

## Multi-Tenancy Architecture

ElizaOS implements a multi-tenant architecture where each agent operates in its own isolated data space:

- **Agent Isolation**: Each agent has its own `agentId` that scopes all database operations
- **Data Segregation**: All queries are automatically filtered by the agent's ID
- **Shared Infrastructure**: Multiple agents can share the same database instance while maintaining complete data isolation
- **Embedding Consistency**: Each agent must use consistent embedding dimensions throughout its lifecycle

> ⚠️ **Important**: Each agent MUST use the same embedding model throughout its lifetime. Mixing different embedding models (e.g., OpenAI with Google embeddings) within the same agent will cause vector search failures and inconsistent results.

## Core Functionality

All database adapters extend the `BaseDrizzleAdapter` abstract class, which provides a comprehensive set of methods for managing all aspects of agent data:

### Entity System

| Method                   | Description                           |
| ------------------------ | ------------------------------------- |
| `createEntities()`       | Create new entities                   |
| `getEntityByIds()`       | Retrieve entities by IDs              |
| `getEntitiesForRoom()`   | Get all entities in a room            |
| `updateEntity()`         | Update entity attributes              |
| `deleteEntity()`         | Delete an entity                      |
| `getEntitiesByNames()`   | Find entities by their names          |
| `searchEntitiesByName()` | Search entities with fuzzy matching   |
| `getComponent()`         | Get a specific component of an entity |
| `getComponents()`        | Get all components for an entity      |
| `createComponent()`      | Add a component to an entity          |
| `updateComponent()`      | Update a component                    |
| `deleteComponent()`      | Remove a component                    |

### Memory Management

| Method                        | Description                          |
| ----------------------------- | ------------------------------------ |
| `createMemory()`              | Store a new memory with metadata     |
| `getMemoryById()`             | Retrieve a specific memory           |
| `getMemories()`               | Get memories matching criteria       |
| `getMemoriesByIds()`          | Get multiple memories by IDs         |
| `getMemoriesByRoomIds()`      | Get memories from multiple rooms     |
| `getMemoriesByWorldId()`      | Get memories from a world            |
| `searchMemories()`            | Search memories by vector similarity |
| `searchMemoriesByEmbedding()` | Search using raw embedding vector    |
| `updateMemory()`              | Update an existing memory            |
| `deleteMemory()`              | Remove a specific memory             |
| `deleteManyMemories()`        | Remove multiple memories in batch    |
| `deleteAllMemories()`         | Remove all memories in a room        |
| `countMemories()`             | Count memories matching criteria     |

### Room & Participant Management

| Method                       | Description                     |
| ---------------------------- | ------------------------------- |
| `createRooms()`              | Create new conversation rooms   |
| `getRoomsByIds()`            | Get rooms by their IDs          |
| `getRoomsByWorld()`          | Get all rooms in a world        |
| `updateRoom()`               | Update room attributes          |
| `deleteRoom()`               | Remove a room                   |
| `deleteRoomsByWorldId()`     | Remove all rooms in a world     |
| `addParticipant()`           | Add entity to room              |
| `addParticipantsRoom()`      | Add multiple entities to room   |
| `removeParticipant()`        | Remove entity from room         |
| `getParticipantsForEntity()` | Get all rooms an entity is in   |
| `getParticipantsForRoom()`   | List entities in a room         |
| `getRoomsForParticipant()`   | Get rooms for an entity         |
| `getRoomsForParticipants()`  | Get rooms for multiple entities |
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

| Method            | Description                      |
| ----------------- | -------------------------------- |
| `createAgent()`   | Create a new agent record        |
| `getAgent()`      | Get agent by ID                  |
| `getAgents()`     | List all agents                  |
| `updateAgent()`   | Update agent attributes          |
| `deleteAgent()`   | Remove an agent and all its data |
| `countAgents()`   | Count total agents               |
| `cleanupAgents()` | Clean up orphaned agents         |

### Embedding & Search

| Method                        | Description                           |
| ----------------------------- | ------------------------------------- |
| `ensureEmbeddingDimension()`  | Configure embedding dimensions        |
| `getCachedEmbeddings()`       | Retrieve cached embeddings            |
| `searchMemories()`            | Vector search for memories            |
| `searchMemoriesByEmbedding()` | Advanced vector search with embedding |

### Logging System

| Method        | Description                 |
| ------------- | --------------------------- |
| `log()`       | Create a log entry          |
| `getLogs()`   | Retrieve logs by criteria   |
| `deleteLog()` | Delete a specific log entry |

### Message Server Operations (Central Database)

| Method                     | Description                   |
| -------------------------- | ----------------------------- |
| `createMessageServer()`    | Create a new message server   |
| `getMessageServers()`      | Get all message servers       |
| `getMessageServerById()`   | Get a specific message server |
| `createChannel()`          | Create a new channel          |
| `getChannelsForServer()`   | Get channels for a server     |
| `getChannelDetails()`      | Get channel information       |
| `updateChannel()`          | Update channel attributes     |
| `deleteChannel()`          | Delete a channel              |
| `createMessage()`          | Create a new message          |
| `getMessagesForChannel()`  | Get messages from a channel   |
| `deleteMessage()`          | Delete a message              |
| `addChannelParticipants()` | Add users to a channel        |
| `getChannelParticipants()` | Get users in a channel        |
| `addAgentToServer()`       | Add agent to a server         |
| `getAgentsForServer()`     | Get agents for a server       |
| `removeAgentFromServer()`  | Remove agent from server      |
| `findOrCreateDmChannel()`  | Find or create DM channel     |

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
│   (Full implementation in base.ts)  │
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
  return new SqliteDatabaseAdapter(agentId, pgLiteClientManager);
}
```

### Configuration

Configure the database adapter using environment variables or settings:

```typescript
// For PostgreSQL
process.env.POSTGRES_URL = 'postgresql://username:password@localhost:5432/elizaos';

// For PGLite (default)
process.env.SQLITE_DATA_DIR = './.elizadb'; // Optional, defaults to './.elizadb'
```

### Embedding Dimension Management

The embedding dimension is set during agent initialization based on the text embedding model:

```typescript
// The dimension is automatically determined by the embedding model
// Common dimensions:
// - OpenAI: 1536
// - Google: 768
// - Anthropic: 1024
// - Local models: varies (384, 512, 768, etc.)

// The system automatically calls ensureEmbeddingDimension()
// when creating the first memory with embeddings
```

> ⚠️ **Critical**: Once an agent starts using a specific embedding model, it MUST continue using the same model. Switching embedding models mid-operation will result in:
>
> - Vector search failures
> - Inconsistent similarity scores
> - Potential runtime errors
> - Degraded agent performance

### Retry Logic & Error Handling

The database system includes built-in retry logic with exponential backoff and jitter:

```typescript
protected async withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (attempt < this.maxRetries) {
        const backoffDelay = Math.min(
          this.baseDelay * 2 ** (attempt - 1),
          this.maxDelay
        );
        const jitter = Math.random() * this.jitterMax;
        const delay = backoffDelay + jitter;

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
```

## Example Usage

Here are examples of common database operations:

### Store a Memory

```typescript
// Memory creation automatically uses the agent's configured embedding dimension
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
// Embedding must be from the same model type as used during creation
const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
  text: 'What did we discuss about databases?',
});

const relevantMemories = await runtime.searchMemories({
  tableName: 'messages',
  embedding,
  roomId: message.roomId,
  count: 5,
  match_threshold: 0.8,
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

- **agents**: Agent configuration and state (multi-tenant root)
- **entities**: The fundamental objects in the system (users, agents, etc.)
- **components**: Modular data attached to entities (profiles, settings, etc.)
- **memories**: Conversation history and other remembered information
- **embeddings**: Vector embeddings for semantic search (supports multiple dimensions)
- **relationships**: Connections between entities
- **rooms**: Conversation channels
- **participants**: Entity participation in rooms
- **worlds**: Container for multiple rooms
- **tasks**: Scheduled or queued operations
- **cache**: Temporary key-value storage
- **logs**: System and event logs

### Message Server Tables (Central Database)

- **message_servers**: Server definitions
- **channels**: Communication channels
- **messages**: Message history
- **channel_participants**: Channel membership
- **server_agents**: Agent-server associations

### Entity-Component System

ElizaOS uses an entity-component architecture where:

- Entities are the base objects (users, agents, etc.)
- Components are pieces of data attached to entities
- This allows for flexible data modeling and extension

For example, a user entity might have profile, preferences, and authentication components.

## Vector Search

Both adapters support vector-based semantic search with embedding dimension flexibility:

- **PostgreSQL**: Uses pgvector extension for optimized vector operations
- **PGLite**: Implements vector search using cosine distance calculations

The system supports multiple embedding dimensions (384, 512, 768, 1024, 1536, 3072) but each agent must use only one consistently:

```typescript
// The embedding dimension is automatically set based on the first embedding stored
// Supported dimensions are defined in DIMENSION_MAP
const DIMENSION_MAP = {
  384: 'dim_384',
  512: 'dim_512',
  768: 'dim_768',
  1024: 'dim_1024',
  1536: 'dim_1536',
  3072: 'dim_3072',
};
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
SQLITE_DATA_DIR=./my-data
```

### What about embedding model consistency?

**Critical Requirements:**

1. Each agent must use the same embedding model throughout its lifetime
2. Never mix embedding models within the same agent
3. If you need to change models, create a new agent
4. Document which embedding model each agent uses

**Why this matters:**

- Different models produce embeddings of different dimensions
- Embeddings from different models are not comparable
- Mixing models will break vector search functionality

### How does multi-tenancy work?

- Each agent operates in its own isolated data space
- All database operations are automatically scoped by `agentId`
- Multiple agents can share the same database instance
- Data isolation is enforced at the query level
- No cross-agent data access is possible

### How can I inspect the database contents?

For PostgreSQL, use standard PostgreSQL tools like pgAdmin or psql.

For PGLite, the data is stored in the specified data directory. You can use the PGLite Studio or standard PostgreSQL clients that support local connections.

### How do I handle agent deletion?

The `deleteAgent()` method performs a complete cascade deletion:

1. Deletes all memories and embeddings
2. Removes all entities and components
3. Cleans up rooms and participants
4. Removes relationships and logs
5. Deletes the agent record itself

This ensures no orphaned data remains in the database.

### How can I improve database performance?

- For **PostgreSQL**:

  - Ensure the pgvector extension is properly installed
  - Create indexes on frequently queried fields
  - Use connection pooling
  - Consider partitioning for large datasets

- For **PGLite**:
  - Keep database size reasonable (under 1GB)
  - Regularly clean up old memories
  - Limit the number of concurrent operations

### Will other database adapters be supported in the future?

The adapter interface is designed to be extensible. Future releases may include support for additional databases, but all will need to implement the full `IDatabaseAdapter` interface as defined in the `BaseDrizzleAdapter`.

## Further Reading

- [Entity System](./entities.md)
- [Agent Runtime](./agents.md)
