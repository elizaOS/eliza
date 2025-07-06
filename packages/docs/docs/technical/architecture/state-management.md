# State Management Architecture

ElizaOS implements a sophisticated state management system that handles dynamic state composition, memory persistence, and efficient caching across multiple agents and platforms.

## Overview

The state management system is built around three core concepts:

1. **State Composition** - Dynamic aggregation of context from multiple providers
2. **Memory System** - Persistent storage with semantic search capabilities
3. **Caching Layer** - Efficient state retrieval and composition optimization

## State Architecture

### State Interface

```typescript
interface State {
  values: { [key: string]: any }; // Direct state values
  data: { [key: string]: any }; // Structured/provider data
  text: string; // Textual context summary
  [key: string]: any; // Dynamic properties
}
```

The state object serves as the primary context container that agents use to make decisions and generate responses.

### State Composition Process

State composition follows a structured pipeline:

1. **Provider Registration** - Providers register with the runtime during initialization
2. **Context Assembly** - State is dynamically composed by aggregating provider outputs
3. **Caching** - Composed states are cached by message ID for performance
4. **Template Rendering** - State is used to render prompt templates

#### Provider Aggregation

```typescript
// packages/core/src/runtime.ts:composeState()
async composeState(
  message: Memory,
  additionalKeys?: { [key: string]: string }
): Promise<State> {
  // 1. Check cache for existing state
  const cachedState = this.stateCache.get(message.id);
  if (cachedState) return cachedState;

  // 2. Initialize base state
  const state: State = {
    values: {},
    data: {},
    text: ''
  };

  // 3. Aggregate provider data
  const providerOutputs = await Promise.all(
    this.providers
      .filter(provider => shouldIncludeProvider(provider, message))
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .map(provider => provider.get(this, message, state))
  );

  // 4. Merge provider outputs into state
  for (const output of providerOutputs) {
    if (output?.text) state.text += output.text + '\n';
    if (output?.data) Object.assign(state.data, output.data);
    if (output?.values) Object.assign(state.values, output.values);
  }

  // 5. Cache and return composed state
  this.stateCache.set(message.id, state);
  return state;
}
```

#### Provider Position System

Providers are executed in order based on their `position` property:

- **Low numbers (0-100)**: Base context (character, world state)
- **Medium numbers (100-500)**: Dynamic context (recent messages, entities)
- **High numbers (500+)**: Real-time context (current conversation, immediate state)

## Memory System

### Memory Types

ElizaOS supports multiple memory types for different use cases:

```typescript
enum MemoryType {
  DOCUMENT = 'document', // Complete documents or large text chunks
  FRAGMENT = 'fragment', // Document segments for embedding/search
  MESSAGE = 'message', // Conversational messages
  DESCRIPTION = 'description', // Descriptive information about entities
  CUSTOM = 'custom', // Extension point for custom types
}
```

### Memory Structure

```typescript
interface Memory {
  id: UUID;
  entityId: UUID; // User/agent who created this memory
  worldId?: UUID; // World/server context
  roomId?: UUID; // Room/channel context
  content: Content; // Text content with metadata
  type: MemoryType;
  metadata?: {
    scope: 'shared' | 'private' | 'room';
    source?: string; // Origin platform/service
    timestamp: number;
    sequence?: number; // Ordering within conversation
    [key: string]: any; // Custom metadata
  };
}
```

### Memory Operations

#### Creating Memories

```typescript
// Store a new memory
await runtime.memory.create({
  entityId: message.entityId,
  worldId: message.worldId,
  roomId: message.roomId,
  content: {
    text: 'Important information to remember',
    metadata: { type: 'fact' },
  },
  type: MemoryType.DESCRIPTION,
  metadata: {
    scope: 'shared',
    source: 'discord',
    timestamp: Date.now(),
  },
});
```

#### Retrieving Memories

```typescript
// Search memories by content similarity
const memories = await runtime.memory.searchMemoriesByEmbedding(embedding, {
  match_threshold: 0.8,
  count: 10,
  tableName: 'memories',
  worldId: message.worldId,
  roomId: message.roomId,
});

// Get recent memories in a room
const recent = await runtime.memory.getMemories({
  roomId: message.roomId,
  count: 20,
  unique: false,
});
```

### Memory Scoping

ElizaOS implements three memory scoping levels:

1. **Private** (`scope: 'private'`) - Only accessible to the creating agent
2. **Room** (`scope: 'room'`) - Shared within a specific room/channel
3. **Shared** (`scope: 'shared'`) - Globally accessible across the world

### Semantic Search

Memory retrieval uses vector embeddings for semantic search:

```typescript
// packages/core/src/memory.ts
async searchMemoriesByEmbedding(
  embedding: number[],
  options: {
    match_threshold?: number;  // Similarity threshold (0-1)
    count?: number;            // Maximum results
    tableName: string;         // Target memory table
    worldId?: UUID;            // World context filter
    roomId?: UUID;             // Room context filter
  }
): Promise<Memory[]>
```

## Caching System

### State Cache

The runtime maintains an in-memory cache of composed states:

```typescript
// packages/core/src/runtime.ts
private stateCache = new Map<UUID, State>();

// Cache management
private pruneStateCache(): void {
  if (this.stateCache.size > 1000) {
    // Remove oldest entries when cache grows too large
    const entries = Array.from(this.stateCache.entries());
    entries.slice(0, 500).forEach(([key]) => {
      this.stateCache.delete(key);
    });
  }
}
```

### Cache Invalidation

State cache is automatically managed:

- **Cache Hit**: Returns cached state if available for message ID
- **Cache Miss**: Composes new state and caches result
- **Cache Pruning**: Automatic cleanup when cache size exceeds limits
- **Manual Invalidation**: Cache can be cleared during runtime operations

## Database Integration

### Database Adapter Pattern

ElizaOS uses the `IDatabaseAdapter` interface to abstract database operations:

```typescript
interface IDatabaseAdapter {
  // Memory operations
  createMemory(memory: Memory, tableName: string): Promise<void>;
  getMemories(params: GetMemoriesParams): Promise<Memory[]>;
  searchMemoriesByEmbedding(embedding: number[], options: SearchOptions): Promise<Memory[]>;

  // Entity operations
  createEntity(entity: Entity): Promise<boolean>;
  getEntity(params: { id: UUID }): Promise<Entity | null>;

  // World operations
  createWorld(world: World): Promise<boolean>;
  getWorlds(params: { entityId: UUID }): Promise<World[]>;

  // Room operations
  createRoom(room: Room): Promise<boolean>;
  getRoom(params: { id: UUID }): Promise<Room | null>;
}
```

### Supported Databases

- **PostgreSQL** - Production database with full feature support
- **PGLite** - Lightweight SQLite-compatible database for development
- **Custom Adapters** - Extensible adapter system for other databases

## Best Practices

### State Management

1. **Provider Positioning** - Use appropriate position values to control execution order
2. **Efficient Providers** - Keep provider logic lightweight and fast
3. **State Immutability** - Don't modify state objects after composition
4. **Cache Awareness** - Consider caching behavior when designing providers

### Memory Management

1. **Appropriate Scoping** - Choose correct scope level for memory visibility
2. **Metadata Usage** - Include relevant metadata for filtering and organization
3. **Memory Types** - Use specific memory types for semantic organization
4. **Search Optimization** - Structure content for effective semantic search

### Performance Considerations

1. **Provider Efficiency** - Minimize database queries in providers
2. **Batch Operations** - Use batch operations for multiple memory writes
3. **Embedding Caching** - Cache embeddings when possible to avoid recomputation
4. **Memory Cleanup** - Implement periodic cleanup of old memories

## Error Handling

### State Composition Errors

```typescript
try {
  const state = await runtime.composeState(message);
} catch (error) {
  console.error('State composition failed:', error);
  // Fallback to minimal state
  return {
    values: {},
    data: {},
    text: message.content.text || '',
  };
}
```

### Memory Operation Errors

```typescript
try {
  await runtime.memory.create(memory);
} catch (error) {
  if (error.code === 'DUPLICATE_KEY') {
    // Handle duplicate memory
  } else {
    // Log and continue
    console.error('Memory creation failed:', error);
  }
}
```

## Integration Examples

### Custom Provider

```typescript
const customProvider: Provider = {
  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    // Fetch relevant context data
    const context = await fetchCustomContext(message);

    return {
      text: `Custom context: ${context.summary}`,
      data: { customData: context },
      values: { hasCustomContext: true },
    };
  },
};

// Register provider
runtime.registerProvider(customProvider);
```

### Memory-Backed Provider

```typescript
const memoryProvider: Provider = {
  get: async (runtime: IAgentRuntime, message: Memory) => {
    // Search for relevant memories
    const memories = await runtime.memory.searchMemoriesByEmbedding(
      await runtime.embed(message.content.text),
      {
        match_threshold: 0.7,
        count: 5,
        tableName: 'memories',
        roomId: message.roomId,
      }
    );

    return {
      text: memories.map((m) => m.content.text).join('\n'),
      data: { relevantMemories: memories },
    };
  },
};
```

This state management system provides the foundation for ElizaOS's intelligent agent behavior, enabling dynamic context composition, persistent memory, and efficient state handling across complex multi-agent environments.
