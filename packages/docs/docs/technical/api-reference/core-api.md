---
title: Core API Reference
description: Complete API reference for ElizaOS core components
---

# Core API Reference

This document provides a comprehensive reference for the ElizaOS Core API, including all interfaces, types, and functions available for plugin and application development.

## IAgentRuntime

The main runtime interface that provides access to all agent functionality.

```typescript
interface IAgentRuntime {
  // Agent Information
  agentId: string;
  character: Character;

  // Managers
  databaseAdapter: IDatabaseAdapter;
  messageManager: IMemoryManager;
  documentsManager: IMemoryManager;
  descriptionManager: IMemoryManager;

  // State Management
  state: State | null;

  // Plugin Management
  plugins: string[];
  actions: Action[];
  evaluators: Evaluator[];
  providers: Provider[];

  // Services
  services: Map<string, Service>;
  getService<T extends Service>(name: string): T | null;
  registerService(name: string, service: Service): void;

  // Settings
  getSetting(key: string): any;
  setSetting(key: string, value: any): void;

  // Memory Operations
  processActions(message: Memory, messages: Memory[], state?: State): Promise<Memory[]>;
  evaluate(message: Memory, state?: State): Promise<string[]>;
  ensureParticipantInRoom(userId: string, roomId: string): Promise<void>;

  // Utility Methods
  completion(params: CompletionParams): Promise<string>;
  embed(text: string): Promise<number[]>;

  // Logging
  logger: ILogger;
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
  id?: string;
  userId: string;
  agentId: string;
  roomId: string;

  content: Content;

  createdAt?: string;
  embedding?: number[];

  [key: string]: any; // Additional metadata
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

type Validator = (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State
) => Promise<boolean>;

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
      userId: runtime.agentId,
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
      userId: runtime.agentId,
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
  get: (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
  ) => Promise<string>;
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
      // Update goal progress
      await runtime.databaseAdapter.updateGoal({
        ...state.currentGoal,
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
        userId: message.userId,
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

  // User Management
  getAccountById(userId: string): Promise<Account | null>;
  createAccount(account: Account): Promise<boolean>;
  getAccounts(): Promise<Account[]>;

  // Room Management
  getRoom(roomId: string): Promise<string | null>;
  createRoom(roomId: string): Promise<boolean>;
  removeRoom(roomId: string): Promise<boolean>;
  getRoomsForParticipant(userId: string): Promise<string[]>;
  getRoomsForParticipants(userIds: string[]): Promise<string[]>;

  // Participant Management
  addParticipant(userId: string, roomId: string): Promise<boolean>;
  removeParticipant(userId: string, roomId: string): Promise<boolean>;
  getParticipantsForRoom(roomId: string): Promise<string[]>;

  // Participant State
  getParticipantUserState(roomId: string, userId: string): Promise<'FOLLOWED' | 'MUTED' | null>;

  setParticipantUserState(
    roomId: string,
    userId: string,
    state: 'FOLLOWED' | 'MUTED' | null
  ): Promise<void>;

  // Memory Management
  createMemory(memory: Memory, tableName: string): Promise<void>;
  getMemories(params: {
    roomId: string;
    count?: number;
    unique?: boolean;
    tableName: string;
    start?: number;
    end?: number;
  }): Promise<Memory[]>;

  searchMemories(params: {
    tableName: string;
    roomId: string;
    embedding: number[];
    match_threshold?: number;
    match_count?: number;
    unique?: boolean;
  }): Promise<Memory[]>;

  // Goal Management
  createGoal(goal: Goal): Promise<void>;
  getGoals(params: {
    roomId: string;
    userId?: string;
    onlyInProgress?: boolean;
    count?: number;
  }): Promise<Goal[]>;
  updateGoal(goal: Goal): Promise<void>;
  removeGoal(goalId: string): Promise<void>;

  // Relationship Management
  createRelationship(params: { userA: string; userB: string }): Promise<boolean>;

  getRelationship(params: { userA: string; userB: string }): Promise<Relationship | null>;

  getRelationships(params: { userId: string }): Promise<Relationship[]>;

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
        userId: runtime.agentId,
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
    typeof result.userId === 'string' &&
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
