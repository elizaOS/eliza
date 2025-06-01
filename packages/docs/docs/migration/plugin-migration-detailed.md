# Eliza Plugin Migration Guide: 0.x to 1.x

## Table of Contents

1. [Introduction and Architectural Philosophy Changes](#introduction-and-architectural-philosophy-changes)
2. [Entity System Revolution](#entity-system-revolution)
3. [Client-to-Service Migration](#client-to-service-migration)
4. [Plugin Empowerment](#plugin-empowerment)
5. [The New Task System](#the-new-task-system)
6. [Core Import and Type Changes](#core-import-and-type-changes)
7. [Memory System Evolution](#memory-system-evolution)
8. [Model System Transformation](#model-system-transformation)
9. [World and Room Hierarchy](#world-and-room-hierarchy)
10. [Event System Architecture](#event-system-architecture)
11. [Runtime Slimming](#runtime-slimming)
12. [Action System Updates](#action-system-updates)
13. [Provider System Maturity](#provider-system-maturity)
14. [Knowledge System as Plugin](#knowledge-system-as-plugin)
15. [Testing and Build System](#testing-and-build-system)
16. [Migration Strategy](#migration-strategy)
17. [Common Pitfalls and Solutions](#common-pitfalls-and-solutions)

---

## 1. Introduction and Architectural Philosophy Changes

Before diving into technical changes, understand these critical shifts:

```typescript
// Version 0.x Mindset:
// - Runtime handles model calls
// - Users and agents are different
// - Clients connect to platforms
// - Runtime provides utilities

// Version 1.x Mindset:
// - Plugins handle model calls
// - Everything is an entity
// - Services connect to platforms
// - Plugins are self-contained
```

---

## 2. Entity System Revolution

In 0.x, we had a clear distinction between users and agents. In 1.x, this distinction is gone.

**Old System (0.x):**

```typescript
// From types-old.txt
export interface Account {
  id: UUID;
  name: string;
  username: string;
  details?: { [key: string]: any };
  email?: string;
  avatarUrl?: string;
}

// Usage in memory
export interface Memory {
  userId: UUID; // Could be human or agent
  agentId: UUID; // The agent in conversation
  // ...
}
```

**New System (1.x):**

```typescript
// From types-new.txt
export interface Entity {
  id?: UUID;
  names: string[]; // Multiple names/aliases
  metadata?: { [key: string]: any };
  agentId: UUID; // Which agent manages this entity
  components?: Component[];
}

// Usage in memory
export interface Memory {
  entityId: UUID; // ANY participant (human, agent, bot)
  agentId?: UUID; // Optional agent association
  // ...
}
```

### Migrating User References

**Example from OpenAI Plugin:**

```typescript
// OLD (openai-old.txt)
async handler(_runtime, message, _state) {
    const response = await callOpenAiApi(
        "https://api.openai.com/v1/completions",
        requestData,
        apiKey,
    );

    // Reference to userId
    runtime.databaseAdapter.log({
        userId: message.userId,
        roomId: message.roomId,
        type: "action",
        body: { /* ... */ }
    });
}

// NEW (openai-new.txt)
async handler(runtime: IAgentRuntime, message: Memory, state?: State) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: prompt,
    });

    // Reference to entityId
    runtime.adapter.log({
        entityId: message.entityId,  // Changed from userId
        roomId: message.roomId,
        type: "action",
        body: { /* ... */ }
    });
}
```

### Entity Components

The new component system allows flexible data modeling:

```typescript
// Creating an entity with components
const entity = await runtime.createEntity({
  names: ['John Doe', 'JohnD'],
  agentId: runtime.agentId,
  metadata: {
    discord: {
      username: 'john_doe',
      id: '123456789',
    },
  },
});

// Adding a component
await runtime.createComponent({
  id: generateId(),
  entityId: entity.id,
  agentId: runtime.agentId,
  roomId: roomId,
  worldId: worldId,
  sourceEntityId: runtime.agentId,
  type: 'preferences',
  data: {
    language: 'en',
    timezone: 'UTC',
  },
});
```

---

## 3. Client-to-Service Migration

### Complete Client Deprecation

Every client in 0.x is now a service in 1.x. This isn't just a naming change—it's a complete architectural shift.

**Old Client Pattern (0.x):**

```typescript
// From types-old.txt
export type Client = {
  name: string;
  config?: { [key: string]: any };
  start: (runtime: IAgentRuntime) => Promise<ClientInstance>;
};

export type ClientInstance = {
  stop: (runtime: IAgentRuntime) => Promise<unknown>;
};
```

**New Service Pattern (1.x):**

```typescript
// From types-new.txt
export abstract class Service {
  protected runtime!: IAgentRuntime;

  abstract stop(): Promise<void>;
  static serviceType: string;
  abstract capabilityDescription: string;

  static async start(_runtime: IAgentRuntime): Promise<Service> {
    throw new Error('Not implemented');
  }
}
```

### Real Service Migration Example

Let's look at how a Discord integration would migrate:

**Old Discord Client (0.x style):**

```typescript
const discordClient: Client = {
  name: 'discord',
  config: {
    token: process.env.DISCORD_TOKEN,
    intents: [
      /* ... */
    ],
  },
  start: async (runtime) => {
    const client = new DiscordClient();

    await client.login(runtime.getSetting('DISCORD_TOKEN'));

    client.on('messageCreate', async (message) => {
      // Handle message
    });

    return {
      stop: async () => {
        await client.destroy();
      },
    };
  },
};
```

**New Discord Service (1.x):**

```typescript
export class DiscordService extends Service {
    static serviceType = 'discord';
    capabilityDescription = 'Discord integration service for message handling';

    private client: DiscordClient;

    constructor(runtime: IAgentRuntime) {
        super();
        this.runtime = runtime;
    }

    static async start(runtime: IAgentRuntime): Promise<DiscordService> {
        const service = new DiscordService(runtime);

        service.client = new DiscordClient();
        await service.client.login(runtime.getSetting('DISCORD_TOKEN'));

        service.client.on('messageCreate', async (message) => {
            // Emit runtime event instead of direct handling
            await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
                runtime,
                message: /* converted message */,
                source: 'discord'
            });
        });

        return service;
    }

    async stop(): Promise<void> {
        await this.client.destroy();
    }
}
```

### Service Registration

**Old Plugin (0.x):**

```typescript
export const discordPlugin: Plugin = {
  name: 'discord',
  clients: [discordClient], // Array of clients
  // ...
};
```

**New Plugin (1.x):**

```typescript
export const discordPlugin: Plugin = {
  name: 'discord',
  services: [DiscordService], // Array of service classes
  // ...
};
```

---

## 4. Plugin Empowerment

The most dramatic change: the runtime no longer handles model calls directly.

**Old Model Call (0.x - openai-old.txt):**

```typescript
// Runtime provided model utilities
import { generateText } from '@elizaos/core';

const response = await generateText({
  runtime,
  context: prompt,
  modelClass: ModelClass.LARGE,
});
```

**New Model Call (1.x - openai-new.txt):**

```typescript
// Plugin registers model handlers
export const openaiPlugin: Plugin = {
  name: 'openai',
  models: {
    [ModelType.TEXT_SMALL]: async (runtime: IAgentRuntime, params) => {
      const openai = createOpenAIClient(runtime);
      const { text } = await generateText({
        model: openai.languageModel(getSmallModel(runtime)),
        prompt: params.prompt,
        temperature: params.temperature || 0.7,
        // ...
      });
      return text;
    },
    [ModelType.TEXT_EMBEDDING]: async (runtime: IAgentRuntime, params) => {
      // Plugin handles embedding generation
      const response = await fetch(`${embeddingBaseURL}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: embeddingModelName,
          input: params.text,
        }),
      });
      // ...
    },
  },
};
```

### Self-Contained Utilities

Plugins must now include their own utility functions.

**Old Approach (0.x):**

```typescript
// Relied on runtime utilities
import { parseJSON, validatePrompt, formatResponse } from "@elizaos/core";

async handler(runtime, message) {
    const parsed = parseJSON(message.content);
    const validated = validatePrompt(parsed.prompt);
    const formatted = formatResponse(response);
}
```

**New Approach (1.x):**

```typescript
// Plugin includes its own utilities
import { parseJSONObjectFromText } from './utils';

// From openai-new.txt
function validatePrompt(prompt: string): void {
    if (!prompt.trim()) {
        throw new Error("Prompt cannot be empty");
    }
    if (prompt.length > 4000) {
        throw new Error("Prompt exceeds maximum length");
    }
}

async handler(runtime, message) {
    // Use plugin's own utilities
    const parsed = parseJSONObjectFromText(message.content.text);
    validatePrompt(parsed.prompt);
    // Format response ourselves
}
```

### Complete Plugin Example

Here's how the OpenAI plugin transformed to be self-sufficient:

**Key Changes in openai-new.txt:**

```typescript
// 1. Plugin provides own OpenAI client creation
function createOpenAIClient(runtime: IAgentRuntime) {
    return createOpenAI({
        apiKey: getApiKey(runtime),
        baseURL: getBaseURL(runtime),
    });
}

// 2. Plugin handles all model types
models: {
    [ModelType.TEXT_SMALL]: textHandler,
    [ModelType.TEXT_LARGE]: textHandler,
    [ModelType.TEXT_EMBEDDING]: embeddingHandler,
    [ModelType.IMAGE]: imageHandler,
    [ModelType.TRANSCRIPTION]: transcriptionHandler,
    // ... many more
}

// 3. Plugin includes error handling and retries
async function callOpenAiApi<T>(url: string, data: any, apiKey: string): Promise<T> {
    try {
        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(data),
        });

        if (!response.ok) {
            // Plugin handles its own errors
            if (response.status === 429) {
                throw new Error("Rate limit exceeded");
            }
            throw new Error(`OpenAI API error: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        // Plugin-specific error handling
        logger.error("OpenAI API call failed:", error);
        throw error;
    }
}

// 4. Plugin manages its own configuration
function getApiKey(runtime: IAgentRuntime): string | undefined {
    return runtime.getSetting("OPENAI_API_KEY");
}
```

---

## 5. The New Task System

Tasks are a completely new abstraction in 1.x for handling deferred and recurring work.

### Task Structure

```typescript
// From types-new.txt
export interface Task {
  id?: UUID;
  name: string;
  updatedAt?: number;
  metadata?: {
    updateInterval?: number; // For recurring tasks
    options?: {
      // For choice tasks
      name: string;
      description: string;
    }[];
    [key: string]: unknown;
  };
  description: string;
  roomId?: UUID;
  worldId?: UUID;
  entityId?: UUID;
  tags: string[];
}
```

### Creating a Task Worker

```typescript
// Example: Reminder task worker
runtime.registerTaskWorker({
  name: 'SEND_REMINDER',

  validate: async (runtime, message, state) => {
    // Check if this task should run
    return state.remindersEnabled && message.content.text.includes('remind');
  },

  execute: async (runtime, options, task) => {
    const { reminder, targetEntityId } = options;

    // Create a memory (message) for the reminder
    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        roomId: task.roomId,
        content: {
          text: `Reminder for <@${targetEntityId}>: ${reminder}`,
        },
      },
      'messages'
    );

    // Delete one-time task after execution
    if (!task.metadata?.updateInterval) {
      await runtime.deleteTask(task.id);
    }
  },
});
```

### Task Usage Examples

**One-time Task:**

```typescript
await runtime.createTask({
  name: 'SEND_REMINDER',
  description: 'Send a reminder in 24 hours',
  roomId: message.roomId,
  tags: ['reminder', 'one-time'],
  metadata: {
    scheduledFor: Date.now() + 86400000, // 24 hours
    reminder: 'Submit your report',
    targetEntityId: message.entityId,
  },
});
```

**Recurring Task:**

```typescript
await runtime.createTask({
  name: 'DAILY_STATS',
  description: 'Post daily statistics',
  roomId: channelId,
  worldId: worldId,
  tags: ['stats', 'recurring'],
  metadata: {
    updateInterval: 86400000, // 24 hours
    updatedAt: Date.now(),
  },
});
```

**Choice Task:**

```typescript
await runtime.createTask({
  name: 'CONFIRM_ACTION',
  description: 'Awaiting user confirmation',
  roomId: message.roomId,
  tags: ['confirmation', 'AWAITING_CHOICE'],
  metadata: {
    options: [
      { name: 'approve', description: 'Approve the action' },
      { name: 'reject', description: 'Reject the action' },
    ],
    actionType: 'DELETE_DATA',
    targetData: ['file1.txt', 'file2.txt'],
  },
});
```

---

## 6. Core Import and Type Changes

Here's a comprehensive mapping of import changes:

**Common Import Changes:**

```typescript
// OLD (Version 0.x)
import {
  generateText,
  elizaLogger,
  ModelClass,
  IAgentRuntime,
  Memory,
  State,
  Action,
} from '@elizaos/core';

// NEW (Version 1.x)
import {
  // generateText is GONE - use runtime.useModel
  logger, // renamed from elizaLogger
  ModelType, // replaces ModelClass
  IAgentRuntime,
  Memory,
  State,
  Action,
  EventType, // new
  ServiceType, // new
  UUID, // new typed UUID
} from '@elizaos/core';
```

### Type System Changes

**UUID Type:**

```typescript
// OLD - just strings
const userId: string = 'some-id';

// NEW - typed UUIDs
import { UUID, asUUID } from '@elizaos/core';

const entityId: UUID = asUUID('123e4567-e89b-12d3-a456-426614174000');
// asUUID validates the format
```

**Model Types:**

```typescript
// OLD (0.x)
export enum ModelClass {
  SMALL = 'small',
  MEDIUM = 'medium',
  LARGE = 'large',
  EMBEDDING = 'embedding',
  IMAGE = 'image',
}

// NEW (1.x)
export const ModelType = {
  TEXT_SMALL: 'TEXT_SMALL',
  TEXT_LARGE: 'TEXT_LARGE',
  TEXT_EMBEDDING: 'TEXT_EMBEDDING',
  TEXT_REASONING_SMALL: 'REASONING_SMALL',
  TEXT_REASONING_LARGE: 'REASONING_LARGE',
  IMAGE: 'IMAGE',
  IMAGE_DESCRIPTION: 'IMAGE_DESCRIPTION',
  TRANSCRIPTION: 'TRANSCRIPTION',
  TEXT_TO_SPEECH: 'TEXT_TO_SPEECH',
  // Many more specific types
} as const;
```

**Service Types:**

```typescript
// OLD - string literals
const serviceType = 'image_description';

// NEW - typed enum
import { ServiceType } from '@elizaos/core';
const serviceType = ServiceType.IMAGE_DESCRIPTION;
```

### Interface Changes

**Memory Interface Evolution:**

```typescript
// OLD (0.x)
export interface Memory {
  id?: UUID;
  userId: UUID; // Human or agent
  agentId: UUID; // The agent
  createdAt?: number;
  content: Content;
  embedding?: number[];
  roomId: UUID;
  unique?: boolean;
  similarity?: number;
}

// NEW (1.x)
export interface Memory {
  id?: UUID;
  entityId: UUID; // Any participant
  agentId?: UUID; // Optional agent association
  createdAt?: number;
  content: Content;
  embedding?: number[]; // Auto-generated by runtime
  roomId: UUID;
  worldId?: UUID; // New world association
  unique?: boolean;
  similarity?: number;
  metadata?: MemoryMetadata; // New metadata system
}
```

---

## 7. Memory System Evolution

The biggest change: you must now specify table names explicitly.

**Old Memory Creation (0.x):**

```typescript
// From openai-old.txt actions
await runtime.messageManager.createMemory(memory);
await runtime.documentsManager.createMemory(document);
await runtime.knowledgeManager.createMemory(knowledge);
```

**New Memory Creation (1.x):**

```typescript
// From openai-new.txt
await runtime.createMemory(memory, 'messages');
await runtime.createMemory(document, 'documents');
await runtime.createMemory(knowledge, 'facts');

// Custom tables are supported
await runtime.createMemory(customData, 'my_custom_table');
```

### 7.2 Embedding Generation

**Old Approach (0.x):**

```typescript
// Manual embedding management
import { getEmbeddingZeroVector } from '@elizaos/core';

const memory = {
  content: { text: 'Hello world' },
  embedding: getEmbeddingZeroVector(), // Manual zero vector
  // ...
};

// Or generate embedding manually
const embedding = await runtime.getEmbeddingResponse(text);
memory.embedding = embedding;
```

**New Approach (1.x):**

```typescript
// Runtime handles embeddings automatically
const memory = {
  content: { text: 'Hello world' },
  // NO embedding field needed!
  entityId: message.entityId,
  roomId: message.roomId,
};

// Runtime generates embedding automatically
await runtime.createMemory(memory, 'messages');

// Or use the helper
const memoryWithEmbedding = await runtime.addEmbeddingToMemory(memory);
```

### Memory Metadata System

**New Metadata Structure:**

```typescript
// From types-new.txt
export interface MessageMetadata extends BaseMetadata {
  type: MemoryType.MESSAGE;
}

export interface DocumentMetadata extends BaseMetadata {
  type: MemoryType.DOCUMENT;
}

// Usage
const messageMemory = {
  content: { text: 'Hello' },
  entityId: entityId,
  roomId: roomId,
  metadata: {
    type: MemoryType.MESSAGE,
    source: 'discord',
    timestamp: Date.now(),
    tags: ['greeting', 'intro'],
  },
};
```

### Search Operations

**Old Search (0.x):**

```typescript
const memories = await runtime.messageManager.searchMemoriesByEmbedding(embedding, {
  match_threshold: 0.8,
  count: 10,
  roomId: roomId,
  unique: true,
});
```

**New Search (1.x):**

```typescript
const memories = await runtime.searchMemories({
  tableName: 'messages', // Required table name
  embedding: embedding,
  match_threshold: 0.8,
  count: 10,
  roomId: roomId,
  worldId: worldId, // Optional world filter
  entityId: entityId, // Optional entity filter
  unique: true,
});
```

---

## 8. Model System Transformation

The runtime no longer directly handles model calling directly. Instead, plugins register model handlers, and models are called with the runtime.useModel() handler.

**Old Model Usage (0.x):**

```typescript
// From openai-old.txt
import { generateText } from '@elizaos/core';

const response = await generateText({
  runtime: runtime,
  context: prompt,
  modelClass: ModelClass.LARGE,
  // These were hardcoded in runtime
});
```

**New Model Usage (1.x):**

```typescript
// Runtime delegates to plugin-registered handlers
const response = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: prompt,
  temperature: 0.7,
  maxTokens: 1000,
});
```

### Model Registration

**How Plugins Register Models (from openai-new.txt):**

```typescript
export const openaiPlugin: Plugin = {
  name: 'openai',
  models: {
    [ModelType.TEXT_SMALL]: async (runtime: IAgentRuntime, params) => {
      const openai = createOpenAIClient(runtime);
      const modelName = getSmallModel(runtime);

      const { text } = await generateText({
        model: openai.languageModel(modelName),
        prompt: params.prompt,
        temperature: params.temperature || 0.7,
        maxTokens: params.maxTokens || 8192,
        // ... other params
      });

      return text;
    },

    [ModelType.TEXT_EMBEDDING]: async (runtime: IAgentRuntime, params) => {
      if (params === null) {
        // Special case for initialization
        const embeddingDimension = 1536;
        const testVector = Array(embeddingDimension).fill(0);
        testVector[0] = 0.1;
        return testVector;
      }

      // Normal embedding generation
      const text = typeof params === 'string' ? params : params.text;
      const response = await fetch(`${baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: embeddingModelName,
          input: text,
        }),
      });

      const data = await response.json();
      return data.data[0].embedding;
    },
  },
};
```

### Model Provider Priority

Multiple plugins can register handlers for the same model type:

```typescript
// Plugin A registers with default priority
runtime.registerModel(
  ModelType.TEXT_LARGE,
  handlerA,
  'plugin-a'
  // priority defaults to 0
);

// Plugin B registers with higher priority
runtime.registerModel(
  ModelType.TEXT_LARGE,
  handlerB,
  'plugin-b',
  10 // Higher priority
);

// When called, Plugin B's handler will be used
const response = await runtime.useModel(ModelType.TEXT_LARGE, params);
```

---

## 9. World and Room Hierarchy

Worlds are a new abstraction layer above rooms:

```typescript
// From types-new.txt
export type World = {
  id: UUID;
  name?: string;
  agentId: UUID;
  serverId: string;
  metadata?: {
    ownership?: {
      ownerId: string;
    };
    roles?: {
      [entityId: UUID]: Role;
    };
    [key: string]: unknown;
  };
};
```

### Creating Rooms with Worlds

**Old Room Creation (0.x):**

```typescript
const roomId = await runtime.createRoom();
// Rooms were standalone
```

**New Room Creation (1.x):**

```typescript
// First ensure world exists
await runtime.ensureWorldExists({
  id: worldId,
  name: 'Main Server',
  agentId: runtime.agentId,
  serverId: 'discord-123456',
});

// Then create room in that world
const roomId = await runtime.createRoom({
  id: roomId,
  name: 'general-chat',
  source: 'discord',
  type: ChannelType.GROUP,
  channelId: 'discord-channel-id',
  serverId: 'discord-123456',
  worldId: worldId, // Required!
});
```

### Entity Connections

**Old Connection (0.x):**

```typescript
await runtime.ensureConnection(userId, roomId, userName, userScreenName, source);
```

**New Connection (1.x):**

```typescript
await runtime.ensureConnection({
  entityId: entityId,
  roomId: roomId,
  worldId: worldId, // Must specify world
  userName: userName,
  name: displayName,
  source: 'discord',
  type: ChannelType.GROUP,
  channelId: channelId,
  serverId: serverId,
  userId: platformUserId, // Platform-specific ID
});
```

---

## 10. Event System Architecture

**New Event System (from types-new.txt):**

```typescript
export enum EventType {
  // World events
  WORLD_JOINED = 'WORLD_JOINED',
  WORLD_CONNECTED = 'WORLD_CONNECTED',
  WORLD_LEFT = 'WORLD_LEFT',

  // Message events
  MESSAGE_RECEIVED = 'MESSAGE_RECEIVED',
  MESSAGE_SENT = 'MESSAGE_SENT',

  // Voice events
  VOICE_MESSAGE_RECEIVED = 'VOICE_MESSAGE_RECEIVED',

  // Action events
  ACTION_STARTED = 'ACTION_STARTED',
  ACTION_COMPLETED = 'ACTION_COMPLETED',

  // Model events
  MODEL_USED = 'MODEL_USED',

  // Many more...
}
```

### Event Registration in Plugins

**Old Event Handling (0.x):**

```typescript
// Direct handling in client
client.on('messageCreate', async (message) => {
  // Process message directly
});
```

**New Event System (1.x):**

```typescript
export const myPlugin: Plugin = {
  name: 'my-plugin',
  events: {
    [EventType.MESSAGE_RECEIVED]: [
      async (payload: MessagePayload) => {
        const { runtime, message } = payload;
        // Process message
      },
    ],
    [EventType.WORLD_JOINED]: [
      async (payload: WorldPayload) => {
        const { runtime, world, rooms, entities } = payload;
        // Handle world join
      },
    ],
  },
};
```

### Emitting Events

```typescript
// In a service
await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
  runtime,
  message: convertedMessage,
  source: 'discord',
  callback: async (response) => {
    // Send response back to Discord
  },
});

// Emit multiple events
await runtime.emitEvent([EventType.ACTION_STARTED, EventType.MODEL_USED], eventPayload);
```

---

## 11. Runtime Slimming

**Removed Utilities:**

```typescript
// OLD (0.x) - These no longer exist in runtime:
import {
  generateText, // ❌ Removed
  getEmbeddingZeroVector, // ❌ Removed
  parseJSON, // ❌ Removed
  validateJSON, // ❌ Removed
  formatResponse, // ❌ Removed
  trimTokens, // ❌ Removed
  // ... many more
} from '@elizaos/core';

// NEW (1.x) - Implement in your plugin:
// Import your own utilities or implement them
import { parseJSONObjectFromText } from './utils';
```

### What Runtime Still Provides

```typescript
// Core orchestration
runtime.emitEvent();
runtime.composeState();

// Memory management
runtime.createMemory();
runtime.searchMemories();

// Service management
runtime.getService();
runtime.registerService();

// Model delegation (not execution)
runtime.useModel();
runtime.registerModel();

// Entity management
runtime.createEntity();
runtime.getEntityById();
```

---

## 12. Action System Updates

**Old Single Action (0.x):**

```typescript
const responseContent = {
  text: "I'll help you with that",
  action: 'SEND_EMAIL', // Single action
};
```

**New Multi-Action (1.x):**

```typescript
const responseContent = {
  text: "I'll help you with that",
  actions: ['REPLY', 'SEND_EMAIL', 'LOG_ACTIVITY'], // Multiple actions
  thought: 'User needs help with email, I should send it and log this',
};
```

### Action Handler Updates

**Example from Real Action Migration:**

```typescript
// OLD Action (0.x style)
export const generateImageAction: Action = {
  name: 'GENERATE_IMAGE',
  similes: ['CREATE_IMAGE', 'MAKE_PICTURE'],
  description: 'Generate an image',

  handler: async (runtime, message, state) => {
    const imageService = runtime.getService('image');
    const imageUrl = await imageService.generate(message.content.text);

    return {
      text: `Here's your image: ${imageUrl}`,
      action: 'GENERATE_IMAGE',
    };
  },
};

// NEW Action (1.x)
export const generateImageAction: Action = {
  name: 'GENERATE_IMAGE',
  similes: ['CREATE_IMAGE', 'MAKE_PICTURE'],
  description: 'Generate an image from text description',
  suppressInitialMessage: true, // New property

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ) => {
    // Send initial response
    if (callback) {
      await callback({
        text: "I'm generating that image for you...",
        thought: 'User wants an image, using image generation service',
        actions: ['GENERATE_IMAGE'],
      });
    }

    // Generate image
    const imageUrl = await runtime.useModel(ModelType.IMAGE, {
      prompt: message.content.text,
    });

    // Create follow-up message with image
    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        roomId: message.roomId,
        content: {
          text: "Here's your generated image:",
          attachments: [
            {
              type: 'image',
              url: imageUrl,
            },
          ],
        },
      },
      'messages'
    );

    return true;
  },
};
```

---

## 13. Provider System Maturity

```typescript
// Standard provider - always included
const timeProvider: Provider = {
  name: 'time',
  description: 'Provides current time',
  get: async (runtime, message, state) => {
    return {
      text: `Current time: ${new Date().toISOString()}`,
      values: { currentTime: Date.now() },
    };
  },
};

// Dynamic provider - only when requested
const weatherProvider: Provider = {
  name: 'weather',
  description: 'Provides weather data',
  dynamic: true, // Not included by default
  get: async (runtime, message, state) => {
    // Expensive operation only when needed
    const weather = await fetchWeatherData();
    return { text: formatWeather(weather), values: { weather } };
  },
};

// Private provider - must be explicitly included
const secretProvider: Provider = {
  name: 'secrets',
  description: 'Provides sensitive data',
  private: true, // Never auto-included
  get: async (runtime, message, state) => {
    return { values: { apiKeys: runtime.getSetting('API_KEYS') } };
  },
};
```

### Provider Positioning

```typescript
const earlyProvider: Provider = {
  name: 'context',
  position: -10, // Runs early
  get: async () => {
    /* ... */
  },
};

const lateProvider: Provider = {
  name: 'summary',
  position: 100, // Runs after others
  get: async (runtime, message, state) => {
    // Can use data from earlier providers
    const contextData = state.values.context;
    return { text: summarize(contextData) };
  },
};
```

---

## 14. Knowledge System as Plugin

Knowledge is no longer in core, but in a separate package (@elizaos/plugin-knowledge)

**Old Knowledge (0.x):**

```typescript
// Was part of character definition
const character = {
  name: 'Assistant',
  knowledge: ['I am a helpful assistant', { path: 'knowledge/faq.md' }],
};
```

**New Knowledge (1.x):**

```typescript
// Now requires the knowledge plugin
import { knowledgePlugin } from '@elizaos/plugin-knowledge';

// In character
const character = {
  name: 'Assistant',
  // knowledge field still works but requires plugin
  knowledge: ['facts', { path: 'docs/guide.md' }],
  plugins: [knowledgePlugin], // Must include plugin!
};
```

### RAG System Usage

```typescript
// Knowledge must be added through runtime
await runtime.addKnowledge({
  id: createUniqueUuid(runtime, 'doc-1'),
  content: { text: documentContent },
  metadata: {
    type: MemoryType.DOCUMENT,
    source: 'manual-upload',
  },
});

// Retrieval through memory search
const relevantKnowledge = await runtime.searchMemories({
  tableName: 'knowledge',
  embedding: queryEmbedding,
  match_threshold: 0.8,
  count: 5,
});
```

---

## 15. Testing and Build System

**Old package.json (0.x):**

```json
{
  "scripts": {
    "test": "jest",
    "lint": "biome check .",
    "format": "biome format --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "^1.0.0",
    "jest": "^29.0.0"
  }
}
```

**New package.json (1.x):**

```json
{
  "scripts": {
    "test": "vitest",
    "test:plugins": "elizaos test",
    "lint": "eslint .",
    "format": "prettier --write .",
    "typecheck": "tsc --noEmit",
    "build": "tsc"
  },
  "devDependencies": {
    "vitest": "latest",
    "prettier": "latest",
    "eslint": "latest",
    "typescript": "latest",
    "@elizaos/core": "^1.0.0"
  }
}
```

### Test Structure

**Example Test Migration:**

```typescript
// OLD Jest test
describe('OpenAI Plugin', () => {
  it('should generate text', async () => {
    const response = await generateText({
      runtime: mockRuntime,
      context: 'Hello',
      modelClass: ModelClass.SMALL,
    });
    expect(response).toBeDefined();
  });
});

// NEW Vitest test
import { describe, it, expect, vi } from 'vitest';

describe('OpenAI Plugin', () => {
  it('should handle text generation through model system', async () => {
    const mockRuntime = {
      getSetting: vi.fn((key) => {
        if (key === 'OPENAI_API_KEY') return 'test-key';
        return null;
      }),
      useModel: vi.fn(),
    };

    // Test the model handler directly
    const handler = openaiPlugin.models[ModelType.TEXT_SMALL];
    const response = await handler(mockRuntime, {
      prompt: 'Hello',
      temperature: 0.7,
    });

    expect(response).toBeDefined();
    expect(typeof response).toBe('string');
  });
});
```

---

## 16. Migration Strategy

### Step-by-Step Process

1. **Update Dependencies**

   ```bash
   npm uninstall @elizaos/core@0.x
   npm install @elizaos/core@1.x
   npm install -D vitest prettier eslint
   npm uninstall @biomejs/biome jest
   ```

2. **Update Imports**

   - Search and replace all import paths
   - Remove imports for removed utilities
   - Add new required imports

3. **Convert Types**

   - Account → Entity
   - userId → entityId
   - ModelClass → ModelType
   - Add UUID types

4. **Migrate Clients to Services**

   - Extend Service class
   - Add lifecycle methods
   - Update registration

5. **Update Model Usage**

   - Replace generateText with runtime.useModel
   - Register model handlers
   - Remove runtime model utilities

6. **Fix Memory Operations**

   - Add table names to all operations
   - Remove manual embedding handling
   - Update search parameters

7. **Implement Self-Contained Utilities**

   - Copy needed utilities into plugin
   - Remove runtime utility dependencies

8. **Add Event Handlers**

   - Convert direct handling to events
   - Register event handlers in plugin

9. **Update Tests**

   - Convert to Vitest
   - Update mocks for new architecture
   - Add plugin integration tests

10. **Test Everything**
    - Run unit tests
    - Run plugin tests
    - Test in real runtime

### Migration Checklist

- [ ] All imports updated
- [ ] No references to removed utilities
- [ ] All userId → entityId
- [ ] All Account → Entity
- [ ] Clients converted to Services
- [ ] Service lifecycle implemented
- [ ] Model handlers registered
- [ ] Memory operations use table names
- [ ] No manual embedding generation
- [ ] Events properly registered
- [ ] Tests migrated to Vitest
- [ ] Plugin includes own utilities
- [ ] Build system updated
- [ ] All tests passing

---

## 17. Common Pitfalls and Solutions

### Forgetting Table Names

**Problem:**

```typescript
// This will fail
await runtime.createMemory(memory);
```

**Solution:**

```typescript
// Always specify table name
await runtime.createMemory(memory, 'messages');
```

### 17.2 Still Using Client Patterns

**Problem:**

```typescript
// Old client pattern
const client = {
  start: async (runtime) => {
    /* ... */
  },
};
```

**Solution:**

```typescript
// Use service pattern
class MyService extends Service {
  static serviceType = 'my-service';
  static async start(runtime) {
    /* ... */
  }
  async stop() {
    /* ... */
  }
}
```

### Expecting Runtime Utilities

**Problem:**

```typescript
// These don't exist anymore
import { parseJSON, generateText } from '@elizaos/core';
```

**Solution:**

```typescript
// Include your own utilities
import { parseJSON } from './utils';
// Use model system
const text = await runtime.useModel(ModelType.TEXT_LARGE, params);
```

### Not Registering Models

**Problem:**

```typescript
// Plugin without model registration
export const myPlugin: Plugin = {
  name: 'my-plugin',
  // No models property
};
```

**Solution:**

```typescript
export const myPlugin: Plugin = {
  name: 'my-plugin',
  models: {
    [ModelType.TEXT_LARGE]: myTextHandler,
    [ModelType.TEXT_EMBEDDING]: myEmbeddingHandler,
  },
};
```

### Manual Embedding Management

**Problem:**

```typescript
// Old pattern
memory.embedding = getEmbeddingZeroVector();
```

**Solution:**

```typescript
// Let runtime handle it
// Just don't include embedding field
await runtime.createMemory(memory, 'messages');
```

---

## Conclusion

The migration from 0.x to 1.x represents a fundamental shift in how Eliza plugins work. The key principles to remember:

1. **Everything is an entity** - no more user/agent distinction
2. **Plugins are self-sufficient** - include your own utilities
3. **Services replaced clients** - use proper lifecycle management
4. **Runtime does less** - plugins handle models and utilities
5. **Explicit is better** - table names, world associations, etc.

Take your time with the migration. Test thoroughly at each step. The new architecture provides much more flexibility and power, but requires understanding these fundamental changes.

For additional help, refer to:

- The example plugins in the Eliza repository
- The plugin registry for real-world examples
- The Eliza Discord community for support

Good luck with your migration!
