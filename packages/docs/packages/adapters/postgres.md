# ElizaOS PostgreSQL Adapter

A database adapter plugin for ElizaOS that provides PostgreSQL connectivity with vector embedding support for semantic search capabilities.

## Features

- Seamless integration with ElizaOS memory and knowledge storage systems
- Vector embedding storage and retrieval with pgvector extension
- Support for multiple embedding models and dimensions (OpenAI, Ollama, GaiaNet)
- Robust connection management with automatic retries and circuit breaking
- Full transaction support for safe database operations
- Comprehensive memory, relationship, and knowledge management
- Built-in caching system

## Prerequisites

- PostgreSQL 15+ with pgvector extension installed
- Connection permissions to create tables and extensions

## Installation

Install the adapter via npm:

```bash
npm install @elizaos-plugins/adapter-postgres
```

Or using pnpm:

```bash
pnpm add @elizaos-plugins/adapter-postgres
```

## Configuration

Add the adapter to your ElizaOS configuration and provide the necessary connection details:

```javascript
// agent.config.js
export default {
  // Other ElizaOS configuration
  adapters: ["postgres"],
  // PostgreSQL connection environment variables
  settings: {
    POSTGRES_URL: "postgresql://username:password@localhost:5432/elizaos"
  }
}
```

### Environment Variables

- `POSTGRES_URL` - Required PostgreSQL connection string

## Database Schema

The adapter automatically initializes the required database schema when first connecting, including:

- Setting up the pgvector extension
- Creating all necessary tables (memories, accounts, rooms, etc.)
- Configuring indexes for vector search

The schema includes tables for:
- `accounts` - User and agent profiles
- `rooms` - Conversation containers
- `memories` - Messages and other memory objects with vector embeddings
- `goals` - User and agent goals
- `participants` - Room participation records
- `relationships` - Connections between accounts
- `knowledge` - Agent knowledge base with vector embeddings
- `cache` - Key-value cache storage

## Vector Search

The adapter uses pgvector to provide semantic search through vector embeddings, supporting:

- Multiple embedding models (OpenAI, Ollama, GaiaNet, etc.)
- Automatic dimension detection (1536 for OpenAI, 1024 for Ollama, etc.)
- Cosine similarity search with configurable thresholds
- Text-based keyword search with Levenshtein distance

## Memory Management

The adapter provides methods for:

```typescript
// Creating memories with vector embeddings
await adapter.createMemory(memory, tableName);

// Searching memories by vector similarity
await adapter.searchMemoriesByEmbedding(embedding, options);

// Retrieving memories by various criteria
await adapter.getMemories({ roomId, tableName, count, unique });
```

## Knowledge Management

For agent knowledge base management:

```typescript
// Store knowledge items with vector embeddings
await adapter.createKnowledge(knowledgeItem);

// Search knowledge by vector similarity and text
await adapter.searchKnowledge({
  agentId,
  embedding, 
  match_threshold: 0.8,
  match_count: 10,
  searchText: "optional text"
});

// Remove knowledge
await adapter.removeKnowledge(knowledgeId);
```

## Caching System

The adapter includes a built-in caching system:

```typescript
// Store cache values
await adapter.setCache({ key, agentId, value });

// Retrieve cached values
const value = await adapter.getCache({ key, agentId });

// Delete cache entries
await adapter.deleteCache({ key, agentId });
```

## Connection Management

The adapter implements robust connection handling:

- Circuit breaker pattern to prevent cascading failures
- Automatic connection retry with exponential backoff
- Connection pooling with configurable limits
- Graceful connection cleanup on shutdown

## Development

### Testing

The repository includes a comprehensive test suite:

```bash
# Run tests with Docker for pgvector support
cd src/__tests__
./run_tests.sh
```

Tests require Docker to spin up a PostgreSQL instance with pgvector support.

### Building

```bash
pnpm build
```

## Troubleshooting

### Common Issues

1. **Connection errors**:
   - Verify your PostgreSQL connection string
   - Ensure PostgreSQL is running and accessible
   - Check network connectivity and firewall settings

2. **Vector search issues**:
   - Verify pgvector extension is installed in your PostgreSQL database
   - Ensure embedding dimensions match your model

3. **Permission errors**:
   - The database user needs permission to create extensions and tables
   - For production, consider using a more restricted user after initialization
