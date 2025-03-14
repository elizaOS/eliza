# Memory Management

## Overview

ElizaOS implements a sophisticated memory management system powered by Retrieval-Augmented Generation (RAG). This system enables agents to maintain contextual awareness and knowledge persistence across interactions while optimizing for both performance and accuracy.

The Eliza framework uses multiple types of memory to support an agent's long-term engagement, contextual understanding, and adaptive responses. Each type of memory serves a specific purpose:

- **Message History**: Stores recent conversations to provide continuity within a session. This helps the agent maintain conversational context and avoid repetitive responses within short-term exchanges.

- **Factual Memory**: Holds specific, context-based facts about the user or environment, such as user preferences, recent activities, or specific details mentioned in previous interactions. This type of memory enables the agent to recall user-specific information across sessions.

- **Knowledge Base**: Contains general knowledge the agent might need to respond to broader queries or provide informative answers. This memory is more static, helping the agent retrieve pre-defined data, common responses, or static character lore.

- **Relationship Tracking**: Manages the agent’s understanding of its relationship with users, including details like user-agent interaction frequency, sentiment, and connection history. It is particularly useful for building rapport and providing a more personalized interaction experience over time.

- **RAG Integration**: Uses a vector search to perform contextual recall based on similarity matching. This enables the agent to retrieve relevant memory snippets or knowledge based on the content and intent of the current conversation, making its responses more contextually relevant.

## Memory Types

1. **Memory Managers**:
   - `messageManager`: Manages conversation history.
   - `descriptionManager`: Stores user descriptions.
   - `loreManager`: Handles character lore and background.
   - `documentsManager`: Manages large documents.
   - `knowledgeManager`: Stores searchable document fragments.
   - `ragKnowledgeManager`: Handles RAG-based knowledge retrieval.

1. **Short-term Memory (Message Context)**
   - Stores recent conversation history
   - Automatically managed with configurable retention
   - Used for maintaining immediate context
   - Implemented via the `messageManager`

2. **Long-term Memory (Descriptions)**
   - Persists learned information about users and contexts
   - Stores important facts and relationships
   - Managed through the `descriptionManager`
   - Supports semantic search via vector embeddings

3. **Static Knowledge (Lore)**
   - Contains character-specific information
   - Holds historical data and background context
   - Managed via the `loreManager`
   - Used for maintaining character consistency

4. **Document Storage**
   - Handles large document management
   - Supports multiple file formats
   - Managed through the `documentsManager`
   - Enables reference material integration

5. **RAG Knowledge Base**
   - Searchable document fragments
   - Optimized for semantic retrieval
   - Managed by `ragKnowledgeManager`
   - Supports dynamic knowledge integration
   
---



---

## Memory Systems

The Eliza framework uses multiple specialized memory managers to support different aspects of agent functionality:

```typescript
// Example memory manager usage
const memoryManager = runtime.getMemoryManager("messages");
await memoryManager.createMemory({
    id: messageId,
    content: { text: "Message content" },
    userId: userId,
    roomId: roomId
});
```

Memory managers support operations like:
- `messageManager`: Manages conversation history.
- `descriptionManager`: Stores user descriptions.
- `loreManager`: Handles character lore and background.
- `documentsManager`: Manages large documents.
- `knowledgeManager`: Stores searchable document fragments.
- `ragKnowledgeManager`: Handles RAG-based knowledge retrieval.

- Embedding generation and storage
- Memory search and retrieval
- Memory creation and deletion
- Memory counting and filtering


## Basic Configuration

```typescript
interface MemoryConfig {
    dimensions: number;        // Vector dimensions (default: 1536 for OpenAI)
    matchThreshold: number;    // Similarity threshold (0.0-1.0)
    maxMemories: number;      // Maximum memories to retrieve
    retentionPeriod: string;  // e.g., '30d', '6h'
}

const config: MemoryConfig = {
    dimensions: 1536,
    matchThreshold: 0.8,
    maxMemories: 10,
    retentionPeriod: '30d'
};
```

### Database Setup

#### Development (SQLite)
```typescript
const devConfig = {
    type: 'sqlite',
    database: './dev.db',
    vectorExtension: false    // SQLite doesn't support vector operations natively
};
```

#### Production (PostgreSQL)
```typescript
const prodConfig = {
    type: 'postgres',
    url: process.env.DATABASE_URL,
    vectorExtension: true,    // Enable pgvector extension
    poolConfig: {
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000
    }
};
```

### Memory Operations



#### Creating Memories
```typescript
async function storeMemory(runtime: AgentRuntime, content: string, type: string) {
    const embedding = await runtime.embed(content);
    
    await runtime.messageManager.createMemory({
        content: { text: content },
        embedding,
        userId: runtime.agentId,
        roomId: runtime.roomId,
        type,
        metadata: {
            timestamp: new Date(),
            source: 'user-interaction'
        }
    });
}
```

#### Retrieving Memories
```typescript
async function retrieveRelevantMemories(runtime: AgentRuntime, query: string) {
    const embedding = await runtime.embed(query);
    
    return await runtime.messageManager.searchMemoriesByEmbedding(embedding, {
        match_threshold: 0.8,
        count: 10,
        include_metadata: true
    });
}
```

### RAG Knowledge Integration

1. **Document Processing Pipeline**
```bash
# Convert and process documents
npx folder2knowledge ./docs/content

# Integrate with character knowledge
npx knowledge2character ./characters/agent.json ./knowledge/processed
```

2. **Runtime Integration**
```typescript
// Load and index knowledge
await runtime.ragKnowledgeManager.loadKnowledge({
    path: './knowledge',
    types: ['markdown', 'text'],
    chunkSize: 1000
});

// Query knowledge base
const context = await runtime.ragKnowledgeManager.search(query, {
    maxResults: 5,
    minScore: 0.7
});
```

## Performance Optimization

### Memory Indexing
```sql
-- PostgreSQL vector indexing
CREATE INDEX idx_memory_embedding ON memories 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Composite index for common queries
CREATE INDEX idx_memory_metadata ON memories (user_id, room_id, created_at);
```

### Caching Strategy
```typescript
interface CacheConfig {
    maxAge: number;          // Maximum age in milliseconds
    maxSize: number;         // Maximum number of entries
    cleanupInterval: number; // Cleanup interval in milliseconds
}

const cacheConfig: CacheConfig = {
    maxAge: 3600000,        // 1 hour
    maxSize: 1000,
    cleanupInterval: 300000  // 5 minutes
};
```

### Memory Cleanup
```typescript
// Implement regular cleanup
async function cleanupOldMemories(runtime: AgentRuntime) {
    const result = await runtime.messageManager.cleanup({
        olderThan: '30d',
        excludeTypes: ['critical', 'permanent'],
        batchSize: 1000
    });
    
    console.log(`Cleaned up ${result.count} memories`);
}
```

## Monitoring and Debugging

### Logging Configuration
```typescript
const logging = {
    level: 'debug',
    components: ['memory', 'rag', 'embedding'],
    format: 'json',
    destination: './logs/memory.log'
};
```

### Health Checks
```typescript
async function checkMemoryHealth(runtime: AgentRuntime) {
    const stats = await runtime.messageManager.getStats();
    const health = {
        totalMemories: stats.count,
        oldestMemory: stats.oldestTimestamp,
        averageEmbeddingTime: stats.avgEmbeddingMs,
        cacheHitRate: stats.cacheHitRate
    };
    
    return health;
}
```

---

## Best Practices

1. **Memory Management**
   - Implement regular cleanup routines
   - Use appropriate retention policies
   - Monitor memory usage and performance

2. **Knowledge Base**
   - Structure documents for efficient retrieval
   - Regular updates and maintenance
   - Version control for knowledge base

3. **Security**
   - Implement proper access controls
   - Sanitize input data
   - Regular security audits

4. **Scalability**
   - Use connection pooling
   - Implement proper caching
   - Monitor and optimize performance

### Common Issues and Solutions

1. **Embedding Dimension Mismatch**
   - Verify model configuration matches database schema
   - Check for mixed embedding models in existing data
   - Solution: Migration script for standardizing dimensions

2. **Memory Leaks**
   - Implement proper cleanup routines
   - Monitor memory usage patterns
   - Use connection pooling effectively

3. **Search Performance**
   - Optimize index configuration
   - Tune match thresholds
   - Implement efficient caching

4. **Data Consistency**
   - Use transactions for related operations
   - Implement retry logic for failures
   - Regular integrity checks

---

## FAQ

### How do I fix embedding/vector dimension mismatch errors?
Set `USE_OPENAI_EMBEDDING=TRUE` in .env file or ensure consistent embedding models across your setup.

### How do I reset my agent's memory?
Delete db.sqlite in the agent/data directory and restart the agent. For a complete reset, run `pnpm clean` followed by `pnpm install`.

### What storage options exist for agent memory?
SQLite for simple deployments, PostgreSQL/Supabase for complex needs. MongoDB also supported.

### Where should I store static knowledge vs dynamic memory?
Static knowledge goes in character.json's knowledge section. Dynamic memory uses database storage through memory system.

### How do I enable RAG (Retrieval Augmented Generation)?
Set `"ragKnowledge": true` in character file. Use folder2knowledge to convert documents into knowledge, then knowledge2character to create character files.

### Do I need different memory setup for production?
Yes - PostgreSQL is recommended over SQLite for production deployments.

### How do I configure database adapters for memory?
Set up database URL in .env file and run proper migration scripts with required schema/functions.

### How do I handle large knowledge datasets?
Use proper database storage rather than storing directly in character file. Consider implementing custom vector database for larger datasets.

### How can I manage memory for multiple agents running simultaneously?
Each agent maintains its own memory system. Plan for ~2GB RAM per agent.

### How do I clear memory when changing models?
When switching between embedding models, delete the database and cached data before restarting the agent.

### How do I customize the memory system?
Use different database adapters (PostgreSQL, Supabase, MongoDB) and configure vector stores for knowledge management.

### How do I troubleshoot memory-related issues?
Check runtime logs, verify database connections, and consider clearing cache and database if behavior seems cached.

---

## Further Reading

- [Configuration Guide](./configuration.md)
