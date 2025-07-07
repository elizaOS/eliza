---
title: Core API Reference
description: Complete API reference for ElizaOS core components
---

# Core API Reference

This document provides a comprehensive reference for the ElizaOS Core API, including all interfaces, types, and functions available for plugin and application development.

## IAgentRuntime

The main runtime interface that provides access to all agent functionality.

```typescript
interface IAgentRuntime extends IDatabaseAdapter {
  // Properties
  agentId: UUID;
  character: Character;
  providers: Provider[];
  actions: Action[];
  evaluators: Evaluator[];
  plugins: Plugin[];
  services: Map<ServiceTypeName, Service>;
  events: Map<string, ((params: any) => Promise<void>)[]>;
  fetch?: typeof fetch | null;
  routes: Route[];

  // Plugin Management
  registerPlugin(plugin: Plugin): Promise<void>;
  initialize(): Promise<void>;

  // Database
  getConnection(): Promise<any>;

  // Services
  getService<T extends Service>(service: ServiceTypeName | string): T | null;
  getAllServices(): Map<ServiceTypeName, Service>;
  registerService(service: typeof Service): Promise<void>;

  // Settings (additional methods from runtime)
  getSetting(key: string): any;
  setSetting(key: string, value: any): void;

  // Model Operations
  completion(params: CompletionParams): Promise<string>;
  embed(text: string): Promise<number[]>;

  // Memory Operations (implemented in runtime)
  processActions(message: Memory, messages: Memory[], state?: State): Promise<Memory[]>;
  evaluate(message: Memory, state?: State): Promise<string[]>;
  ensureParticipantInRoom(entityId: UUID, roomId: UUID): Promise<void>;

  // Task Worker Management
  registerTaskWorker(taskHandler: TaskWorker): void;
  getTaskWorker(name: string): TaskWorker | undefined;

  // Agent Lifecycle
  stop(): Promise<void>;

  // Memory Management
  addEmbeddingToMemory(memory: Memory): Promise<Memory>;
  getAllMemories(): Promise<Memory[]>;
  clearAllAgentMemories(): Promise<void>;

  // Run Tracking
  createRunId(): UUID;
  startRun(): UUID;
  endRun(): void;
  getCurrentRunId(): UUID;

  // Entity & Room Management (convenience wrappers)
  getEntityById(entityId: UUID): Promise<Entity | null>;
  getRoom(roomId: UUID): Promise<Room | null>;
  createEntity(entity: Entity): Promise<boolean>;
  createRoom(room: Room): Promise<UUID>;
  addParticipant(entityId: UUID, roomId: UUID): Promise<boolean>;
  getRooms(worldId: UUID): Promise<Room[]>;

  // Messaging
  registerSendHandler(source: string, handler: SendHandlerFunction): void;
  sendMessageToTarget(target: TargetInfo, content: Content): Promise<void>;
}
```

## Core Types

### Character

Defines an agent's personality and behavior.

```typescript
interface Character {
  // Basic Information
  name: string;
  description?: string;
  system?: string;

  // Personality
  bio: string | string[];
  lore: string | string[];
  topics: string | string[];
  adjectives: string | string[];

  // Behavior
  style: {
    all: string | string[];
    chat: string | string[];
    post: string | string[];
  };

  // Examples
  messageExamples: MessageExample[][];
  postExamples: string[];

  // Configuration
  settings?: {
    voice?: {
      model: string;
      url?: string;
    };
    secrets?: Record<string, string>;
    [key: string]: any;
  };

  // Plugins
  plugins: string[];
  clients: string[];

  // Knowledge
  knowledge?: string[];
}
```

### Memory

The core data structure for messages and memories.

```typescript
interface Memory {
  id?: UUID;
  entityId: UUID;
  agentId?: UUID;
  roomId: UUID;

  content: Content;

  createdAt?: number;
  embedding?: number[];

  worldId?: UUID;
  unique?: boolean;
  similarity?: number;
  metadata?: MemoryMetadata;
}

interface Content {
  text: string;
  action?: string;
  source?: string;
  url?: string;
  inReplyTo?: string;

  attachments?: Attachment[];

  [key: string]: any; // Additional content
}

interface Attachment {
  type: 'image' | 'video' | 'audio' | 'file';
  url: string;
  mimeType?: string;
  size?: number;
  metadata?: Record<string, any>;
}
```

### State

Conversation state management.

```typescript
interface State {
  /** Additional dynamic properties */
  [key: string]: any;

  /** Key-value store for general state variables, often populated by providers */
  values: {
    [key: string]: any;
  };

  /** Key-value store for more structured or internal data */
  data: {
    [key: string]: any;
  };

  /** String representation of current context, often a summary or concatenated history */
  text: string;
}

// Note: State is NOT a Map object. It's a plain object with specific properties.
// To store data in state, use state.data or state.values:
// state.data.myKey = myValue;  // ✓ Correct
// state.set('myKey', myValue); // ✗ Incorrect - State is not a Map

interface Goal {
  id: string;
  name: string;
  description?: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  objectives: Objective[];
  createdAt: string;
  updatedAt?: string;
}

interface Objective {
  id: string;
  goal_id: string;
  description: string;
  completed: boolean;
  metadata?: Record<string, any>;
}
```

## Actions

### Action Interface

```typescript
interface Action {
  name: string;
  description: string;
  similes?: string[];
  examples?: ActionExample[][];
  handler: Handler;
  validate: Validator;
}

interface ActionExample {
  name: string;
  content: Content;
}

type Handler = (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  options?: { [key: string]: unknown },
  callback?: HandlerCallback,
  responses?: Memory[]
) => Promise<unknown>;

type Validator = (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<boolean>;

type HandlerCallback = (response: Content, files?: any) => Promise<Memory[]>;
```

### Built-in Actions

```typescript
// Continue action - maintains conversation flow
const CONTINUE_ACTION: Action = {
  name: 'CONTINUE',
  description: 'Continue the conversation',
  validate: async (runtime, message) => true,
  handler: async (runtime, message, state) => {
    const response = await runtime.completion({
      context: state?.recentMessages || '',
      messages: state?.recentMessagesData || [],
    });

    return {
      entityId: runtime.agentId,
      roomId: message.roomId,
      content: { text: response },
    };
  },
};

// Follow Room action - subscribes to a room/channel
const FOLLOW_ROOM_ACTION: Action = {
  name: 'FOLLOW_ROOM',
  description: 'Follow a room or channel',
  validate: async (runtime, message) => {
    return message.content.text.includes('follow') && message.content.text.includes('room');
  },
  handler: async (runtime, message) => {
    const roomId = extractRoomId(message.content.text);
    await runtime.databaseAdapter.setParticipantUserState(roomId, runtime.agentId, 'FOLLOWED');

    return {
      entityId: runtime.agentId,
      roomId: message.roomId,
      content: { text: `Now following room ${roomId}` },
    };
  },
};
```

## Providers

### Provider Interface

```typescript
interface Provider {
  name: string;
  description?: string;
  dynamic?: boolean;
  position?: number;
  private?: boolean;
  get: (runtime: IAgentRuntime, message: Memory, state: State) => Promise<string>;
}
```

### Built-in Providers

```typescript
// Time provider
const timeProvider: Provider = {
  get: async (runtime) => {
    const now = new Date();
    return `Current time: ${now.toISOString()}`;
  },
};

// Facts provider
const factsProvider: Provider = {
  get: async (runtime, message) => {
    const facts = await runtime.documentsManager.searchMemoriesByEmbedding(
      await runtime.embed(message.content.text),
      { count: 5, roomId: message.roomId }
    );

    return facts.map((f) => f.content.text).join('\n');
  },
};

// Conversation provider
const conversationProvider: Provider = {
  get: async (runtime, message) => {
    const recentMessages = await runtime.messageManager.getMemories({
      roomId: message.roomId,
      count: 10,
      unique: false,
    });

    return formatConversation(recentMessages);
  },
};
```

## Evaluators

### Evaluator Interface

```typescript
interface Evaluator {
  name: string;
  description: string;
  similes?: string[];
  examples: EvaluationExample[];
  handler: Handler;
  validate: Validator;
  alwaysRun?: boolean;
}

interface EvaluationExample {
  context: string;
  messages: Array<{
    user: string;
    content: Content;
  }>;
  outcome: string;
}
```

### Built-in Evaluators

```typescript
// Goal evaluator
const goalEvaluator: Evaluator = {
  name: 'GOAL_EVALUATOR',
  description: 'Evaluates progress toward goals',

  validate: async (runtime, message) => {
    return runtime.character.settings?.goals?.enabled === true;
  },

  handler: async (runtime, message, state) => {
    if (!state?.currentGoal) return;

    // Check if message advances goal
    const advances = await checkGoalProgress(message, state.currentGoal, runtime);

    if (advances) {
      // Update goal progress (goals are managed through tasks)
      await runtime.databaseAdapter.updateTask(state.currentGoal.id, {
        updatedAt: new Date().toISOString(),
      });
    }
  },
};

// Fact evaluator
const factEvaluator: Evaluator = {
  name: 'FACT_EVALUATOR',
  description: 'Extracts and stores facts from messages',

  validate: async (runtime, message) => {
    return message.content.text.length > 20;
  },

  handler: async (runtime, message) => {
    const facts = await extractFacts(message.content.text);

    for (const fact of facts) {
      await runtime.documentsManager.createMemory({
        entityId: message.entityId,
        agentId: runtime.agentId,
        roomId: message.roomId,
        content: {
          text: fact,
          source: message.id,
        },
      });
    }
  },
};
```

## Services

### Service Interface

```typescript
abstract class Service {
  protected runtime!: IAgentRuntime;
  static serviceType: string;
  abstract capabilityDescription: string;
  config?: Metadata;

  constructor(runtime?: IAgentRuntime) {
    if (runtime) {
      this.runtime = runtime;
    }
  }

  abstract stop(): Promise<void>;
  static async start(_runtime: IAgentRuntime): Promise<Service> {
    throw new Error('Service must implement static start method');
  }
  static async stop(_runtime: IAgentRuntime): Promise<unknown> {
    return Promise.resolve();
  }
}
```

### Built-in Services

```typescript
// Cache Service
class CacheService extends Service {
  static serviceType = 'cache';

  private cache: Map<string, CacheEntry> = new Map();

  async initialize(runtime: IAgentRuntime): Promise<void> {
    // Initialize cache with settings
    const settings = runtime.getSetting('cache');
    this.maxSize = settings?.maxSize || 1000;
    this.ttl = settings?.ttl || 3600000; // 1 hour
  }

  async get(key: string): Promise<any | null> {
    const entry = this.cache.get(key);

    if (!entry || Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.findOldestEntry();
      if (oldest) this.cache.delete(oldest);
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (ttl || this.ttl),
    });
  }

  async cleanup(): Promise<void> {
    this.cache.clear();
  }
}

// Database Service
class DatabaseService extends Service {
  static serviceType = 'database';

  private adapter: IDatabaseAdapter;

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.adapter = runtime.databaseAdapter;
  }

  async query(sql: string, params?: any[]): Promise<any[]> {
    return this.adapter.query(sql, params);
  }

  async transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.adapter.transaction(callback);
  }
}
```

## Memory Management

### IMemoryManager Interface

```typescript
interface IMemoryManager {
  // Create
  createMemory(memory: Memory): Promise<void>;

  // Read
  getMemories(params: {
    roomId: string;
    count?: number;
    unique?: boolean;
    start?: number;
    end?: number;
  }): Promise<Memory[]>;

  getMemoriesByType(params: { roomId: string; type: string }): Promise<Memory[]>;

  getMemoryById(id: string): Promise<Memory | null>;

  // Search
  searchMemories(params: { roomId: string; query: string; count?: number }): Promise<Memory[]>;

  searchMemoriesByEmbedding(
    embedding: number[],
    params: {
      roomId?: string;
      threshold?: number;
      count?: number;
    }
  ): Promise<Memory[]>;

  // Update
  updateMemory(memory: Memory): Promise<void>;

  // Delete
  removeMemory(id: string): Promise<void>;
  removeAllMemories(roomId: string): Promise<void>;

  // Count
  countMemories(roomId: string): Promise<number>;
}
```

## Database Adapter

### IDatabaseAdapter Interface

```typescript
interface IDatabaseAdapter {
  // Initialization
  init(): Promise<void>;
  close(): Promise<void>;

  // Agent Management
  getAgent(agentId: UUID): Promise<Agent | null>;
  getAgents(): Promise<Partial<Agent>[]>;
  createAgent(agent: Partial<Agent>): Promise<boolean>;
  updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean>;
  deleteAgent(agentId: UUID): Promise<boolean>;

  // Room Management
  getRoomsByIds(roomIds: UUID[]): Promise<Room[] | null>;
  createRooms(rooms: Room[]): Promise<UUID[]>;
  deleteRoom(roomId: UUID): Promise<void>;
  deleteRoomsByWorldId(worldId: UUID): Promise<void>;
  updateRoom(room: Room): Promise<void>;
  getRoomsForParticipant(entityId: UUID): Promise<UUID[]>;
  getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]>;
  getRoomsByWorld(worldId: UUID): Promise<Room[]>;

  // Participant Management
  addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<boolean>;
  removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean>;
  getParticipantsForEntity(entityId: UUID): Promise<Participant[]>;
  getParticipantsForRoom(roomId: UUID): Promise<UUID[]>;

  // Participant State
  getParticipantUserState(roomId: UUID, entityId: UUID): Promise<'FOLLOWED' | 'MUTED' | null>;

  setParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: 'FOLLOWED' | 'MUTED' | null
  ): Promise<void>;

  // Memory Management
  createMemory(memory: Memory, tableName?: string, unique?: boolean): Promise<void>;
  getMemories(params: {
    roomId: UUID;
    count?: number;
    unique?: boolean;
    tableName?: string;
    start?: number;
    end?: number;
    agentId?: UUID;
  }): Promise<Memory[]>;

  searchMemoriesByEmbedding(
    embedding: number[],
    params: {
      match_threshold?: number;
      count?: number;
      roomId?: UUID;
      unique?: boolean;
      tableName?: string;
    }
  ): Promise<Memory[]>;

  getCachedEmbeddings(
    content: string
  ): Promise<{ embedding: number[]; levenshtein_score: number }[]>;

  updateGoalStatus(params: {
    goalId: UUID;
    status: 'COMPLETED' | 'FAILED' | 'IN_PROGRESS';
  }): Promise<void>;

  log(params: any): Promise<void>;

  getMemoriesByIds(memoryIds: UUID[], tableName?: string): Promise<Memory[]>;

  getMemoryById(memoryId: UUID, tableName?: string): Promise<Memory | null>;

  removeMemory(memoryId: UUID, tableName?: string): Promise<void>;

  removeAllMemories(roomId: UUID, tableName?: string): Promise<void>;

  countMemories(roomId: UUID, unique?: boolean, tableName?: string): Promise<number>;

  // Task Management (Note: Goals are managed through tasks)
  createTask(task: Task): Promise<void>;
  getTasks(entityId: UUID): Promise<Task[]>;
  updateTask(task: Task): Promise<void>;
  deleteTask(taskId: UUID): Promise<void>;

  // Relationship Management
  createRelationship(params: {
    entityIdA: UUID;
    entityIdB: UUID;
    world?: World | null;
  }): Promise<boolean>;

  updateRelationship(relationship: Relationship): Promise<void>;

  getRelationships(params: { entityId: UUID; world?: World }): Promise<Relationship[]>;

  getRelationship(params: { entityIdA: UUID; entityIdB: UUID }): Promise<Relationship | null>;

  // Raw Query
  query(sql: string, params?: any[]): Promise<any[]>;

  // Transaction Support
  transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T>;
}
```

## Utility Functions

### Completion

Generate text using the configured language model.

```typescript
interface CompletionParams {
  context: string;
  messages?: Memory[];
  model?: string;
  stop?: string[];
  temperature?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

// Usage
const response = await runtime.completion({
  context: 'You are a helpful assistant',
  messages: recentMessages,
  temperature: 0.8,
  maxTokens: 150,
});
```

### Embedding

Generate embeddings for text.

```typescript
// Generate embedding
const embedding = await runtime.embed('Hello world');

// Search by embedding
const similar = await runtime.messageManager.searchMemoriesByEmbedding(embedding, {
  count: 10,
  threshold: 0.8,
});
```

### Logging

```typescript
interface ILogger {
  level: 'error' | 'warn' | 'info' | 'debug';

  error(message: string, data?: any): void;
  warn(message: string, data?: any): void;
  info(message: string, data?: any): void;
  debug(message: string, data?: any): void;
}

// Usage
runtime.logger.info('Processing message', { messageId: message.id });
runtime.logger.error('Failed to process', { error: error.message });
```

## Lifecycle Hooks

### Plugin Lifecycle

```typescript
interface Plugin {
  // Called when plugin is loaded
  onLoad?: (runtime: IAgentRuntime) => Promise<void>;

  // Called when plugin is unloaded
  onUnload?: (runtime: IAgentRuntime) => Promise<void>;
}
```

### Message Processing Pipeline

```typescript
// 1. Message received
const message = await runtime.messageManager.createMemory(incomingMessage);

// 2. Run evaluators
const evaluations = await runtime.evaluate(message, state);

// 3. Process actions
const responses = await runtime.processActions(message, recentMessages, state);

// 4. Send responses
for (const response of responses) {
  await runtime.messageManager.createMemory(response);
}
```

## Configuration

### Character Configuration

```typescript
// Load character
const character: Character = {
  name: 'Assistant',
  bio: 'A helpful AI assistant',
  style: {
    all: ['helpful', 'friendly'],
    chat: ['conversational'],
  },
  plugins: ['@elizaos/plugin-bootstrap'],
  settings: {
    model: 'gpt-4',
    temperature: 0.7,
  },
};
```

### Runtime Settings

```typescript
// Get setting
const apiKey = runtime.getSetting('openai.apiKey');

// Set setting
runtime.setSetting('cache.ttl', 3600);

// Check feature flag
const debugMode = runtime.getSetting('debug') === true;
```

## Error Handling

### Error Types

```typescript
class ElizaError extends Error {
  code: string;
  details?: any;

  constructor(message: string, code: string, details?: any) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

class ValidationError extends ElizaError {
  constructor(message: string, details?: any) {
    super(message, 'VALIDATION_ERROR', details);
  }
}

class PluginError extends ElizaError {
  constructor(message: string, pluginName: string, details?: any) {
    super(message, 'PLUGIN_ERROR', { plugin: pluginName, ...details });
  }
}
```

### Error Handling Patterns

```typescript
// Action error handling
const safeAction: Action = {
  handler: async (runtime, message) => {
    try {
      return await riskyOperation();
    } catch (error) {
      runtime.logger.error('Action failed', {
        action: 'SAFE_ACTION',
        error: error.message,
        messageId: message.id,
      });

      // Return graceful fallback
      return {
        entityId: runtime.agentId,
        roomId: message.roomId,
        content: {
          text: 'I encountered an error processing that request.',
          error: true,
        },
      };
    }
  },
};

// Service error handling
class RobustService extends Service {
  async performOperation() {
    const maxRetries = 3;
    let lastError;

    for (let i = 0; i < maxRetries; i++) {
      try {
        return await this.attemptOperation();
      } catch (error) {
        lastError = error;
        await this.delay(Math.pow(2, i) * 1000); // Exponential backoff
      }
    }

    throw new Error(`Operation failed after ${maxRetries} attempts: ${lastError.message}`);
  }
}
```

## Type Utilities

### Helper Types

```typescript
// Partial type for updates
type PartialMemory = Partial<Memory> & Pick<Memory, 'id'>;

// Union types for content
type ContentType = 'text' | 'image' | 'video' | 'audio' | 'file';

// Enum for states
enum ParticipantState {
  FOLLOWED = 'FOLLOWED',
  MUTED = 'MUTED',
  NONE = null,
}

// Generic result type
interface Result<T> {
  success: boolean;
  data?: T;
  error?: string;
}
```

### Type Guards

```typescript
// Check if action result is valid
function isValidActionResult(result: any): result is Memory {
  return (
    result &&
    typeof result.entityId === 'string' &&
    typeof result.roomId === 'string' &&
    result.content &&
    typeof result.content.text === 'string'
  );
}

// Check if service exists
function hasService<T extends Service>(
  runtime: IAgentRuntime,
  name: string
): runtime is IAgentRuntime & { getService(): T } {
  return runtime.services.has(name);
}
```

## Constants

```typescript
// Models
export const Models = {
  GPT_4: 'gpt-4',
  GPT_4_TURBO: 'gpt-4-turbo-preview',
  GPT_3_5_TURBO: 'gpt-3.5-turbo',
  CLAUDE_3_OPUS: 'claude-3-opus-20240229',
  CLAUDE_3_SONNET: 'claude-3-sonnet-20240229',
} as const;

// Embedding dimensions
export const EmbeddingDimensions = {
  OPENAI: 1536,
  COHERE: 768,
  CUSTOM: 384,
} as const;

// Memory types
export const MemoryTypes = {
  MESSAGE: 'message',
  FACT: 'fact',
  DOCUMENT: 'document',
  REFLECTION: 'reflection',
} as const;

// Action names
export const Actions = {
  CONTINUE: 'CONTINUE',
  FOLLOW_ROOM: 'FOLLOW_ROOM',
  UNFOLLOW_ROOM: 'UNFOLLOW_ROOM',
  MUTE_ROOM: 'MUTE_ROOM',
  NONE: 'NONE',
} as const;
```

## Further Reading

- [Core Concepts](../architecture/core-concepts.md) - Understand the fundamentals
- [Plugin Development](../development/plugin-development.md) - Build custom plugins
- [Best Practices](../advanced/best-practices.md) - Development guidelines
- [API Examples](https://github.com/elizaos/eliza/tree/main/examples) - Code examples
