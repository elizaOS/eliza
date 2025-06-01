# Understanding the Eliza Plugin Migration: From 0.x to 1.x

This guide will walk you through migrating your plugins from version 0.x to 1.x, but more importantly, it will help you understand why these changes were made and how they create a more powerful, flexible system.

Think of this migration not as a series of mechanical changes, but as learning a new philosophy of how AI agents interact with the world. We'll build your understanding step by step, starting with the core concepts and gradually working through the practical implementation details.

## Part 1: Understanding the Philosophical Shift

Before we dive into any code, let's talk about what's really changing here. The shift from 0.x to 1.x isn't just about updating function calls or changing import statements. We consolidated concepts that felt duplicative, added abstractions that were badly needed and moved more control and power over the runtime into plugins.

We've tried to reduce mental overhead as much as possible while trying to make the best of the tradeoffs with modularity. Overall 1.x is simpler, but some concepts like tasks and event handlers may take some getting used to for developers used to working around the lack of these abstractions in 0.x.

### The End of Human Exceptionalism

In Eliza 0.x, we had a clear distinction between humans and AI agents. There were "users" (humans) and "agents" (AI). This seemed natural at first, but it created unnecessary complexity. Why should the system care whether a message comes from a human or another AI? Why should we have different code paths for handling human users versus AI participants?

In 1.x, we've embraced a radical simplification: everyone is an entity. Whether you're a human chatting on Discord, an AI agent responding to messages, or even a bot that just posts weather updates, you're all entities in the system. This isn't just a naming change; it's a recognition that in the world of digital communication, the distinction between human and AI is becoming less relevant to the system architecture.

Let me show you what this means in practice. In the old system, you might have written code like this:

```typescript
// Old thinking: "Is this a user or an agent?"
if (message.userId === message.agentId) {
  // This is the agent talking to itself
} else {
  // This is a user talking to the agent
}
```

But in the new system, we think differently:

```typescript
// New thinking: "Which entity sent this message?"
// The entity could be anyone - human, AI, bot, system
const senderEntity = await runtime.getEntityById(message.entityId);
// We treat all entities equally
```

We no longer need separate systems for tracking users and agents. We don't need different database tables or different ways of handling relationships. An entity is an entity, and that elegant simplicity ripples through the entire system.

### From Runtime-Centric to Plugin-Centric

In 0.x, the runtime was like an overprotective parent, handling everything for the plugins. Need to call an AI model? The runtime did it. Need to process some text? The runtime had utilities for that. Need to generate embeddings? The runtime took care of it.

This seemed helpful, but it created problems. What if you wanted to use a different AI model provider? What if you needed custom text processing? What if the runtime's way of doing things didn't match your needs? You were stuck.

In 1.x, we've flipped this relationship. Plugins are now adults, capable of handling their own needs. The runtime provides the coordination and core services, but plugins bring their own capabilities. This is like the difference between living in your parents' house where they cook all your meals, versus having your own apartment where you cook what you want, when you want it.

Let me illustrate this with model handling. In the old system:

```typescript
// The runtime knew how to call OpenAI, Claude, etc.
const response = await generateText({
  runtime: runtime,
  context: 'Write a poem',
  modelClass: ModelClass.LARGE,
});
```

The runtime had hardcoded knowledge of different AI providers. But in the new system:

```typescript
// First, your plugin registers its ability to handle models
export const myAIPlugin = {
  name: 'my-ai-provider',
  models: {
    [ModelType.TEXT_LARGE]: async (runtime, params) => {
      // Your plugin decides HOW to generate text
      // Maybe you use OpenAI, maybe Claude, maybe a local model
      return await myCustomModelCall(params);
    },
  },
};

// Then, the runtime just delegates to whatever plugin registered
const response = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: 'Write a poem',
});
```

The runtime no longer needs to know about every possible AI provider. Your plugin brings its own implementation. This is true plugin empowerment.

### Services: The Unification of External Connections

In 0.x, we had "clients" - things that connected to Discord, Twitter, Telegram, etc. But we realized that these weren't just clients; they were providing services to the agent. They were handling messages, managing connections, processing events.

In 1.x, everything that connects to the outside world is a service. This isn't just a renaming; it's a recognition that these components have lifecycles, they need to start up and shut down gracefully, they provide capabilities to the system. They're not just passive clients; they're active service providers.

## Part 2: Beginning Your Migration Journey

Now that you understand the philosophical changes, let's start the practical journey of migrating your plugin. We'll take this step by step, and I'll explain not just what to change, but why each change matters.

### Step 1: Updating Your Mental Model

Before you change a single line of code, you need to update your mental model. Open your plugin code and look for these patterns:

First, find every reference to "user" or "userId". Each time you see one, ask yourself: "Am I treating humans and AI differently here?" In 1.x, you'll need to think in terms of entities instead.

Second, look for every place you're importing utilities from the Eliza core. Ask yourself: "Is my plugin depending on the runtime to do something it should handle itself?" In 1.x, your plugin needs to be self-sufficient.

Third, find your client connections (Discord, Twitter, etc.). Ask yourself: "What service is this really providing to the system?" In 1.x, you'll need to think of these as services with proper lifecycles.

### Step 2: Setting Up Your New Development Environment

Let's start with the practical matter of updating your development environment. The build system has changed from Biome to the more standard Prettier and ESLint, and the test framework has moved from Jest to Vitest. These aren't arbitrary changes; they align Eliza with more widely-used tools in the TypeScript ecosystem.

First, update your package.json file. Remove the old dependencies:

```json
// These lines need to go away
"@biomejs/biome": "^1.0.0",
"jest": "^29.0.0"
```

And add the new ones:

```json
// Add these new tools
"devDependencies": {
    "@elizaos/core": "^1.0.0",  // The new core version
    "vitest": "latest",         // Modern, fast test runner
    "prettier": "latest",       // Code formatting
    "eslint": "latest",         // Code linting
    "typescript": "latest"      // Keep TypeScript updated
}
```

But more importantly, update your scripts section to reflect the new workflow:

```json
"scripts": {
    "test": "vitest",                    // Run unit tests
    "test:plugins": "elizaos test",      // Run Eliza plugin tests
    "lint": "eslint .",                  // Check code quality
    "format": "prettier --write .",      // Format code
    "typecheck": "tsc --noEmit",        // Check types without building
    "build": "tsc"                       // Build the plugin
}
```

Each of these scripts serves a purpose in your development workflow. The test script runs your unit tests quickly during development. The test:plugins script runs your plugin in a simulated Eliza environment. The lint and format scripts keep your code clean and consistent. The typecheck script catches type errors without the overhead of a full build.

### Step 3: Understanding the Entity Migration

Now let's tackle the most fundamental change: the shift from users to entities. This isn't just a find-and-replace operation; it requires understanding how the new entity system works.

In the old system, an Account looked like this:

```typescript
interface Account {
  id: UUID;
  name: string; // Single name
  username: string; // Single username
  details?: { [key: string]: any };
  email?: string;
  avatarUrl?: string;
}
```

This structure assumed a lot about what an "account" was. It assumed everyone had a single name, a single username, maybe an email. Very human-centric thinking.

The new Entity structure is more flexible:

```typescript
interface Entity {
  id?: UUID;
  names: string[]; // Multiple names/aliases
  metadata?: { [key: string]: any };
  agentId: UUID; // Which agent "knows" this entity
  components?: Component[]; // Modular data attachments
}
```

Notice the philosophical differences here. An entity can have multiple names because in the real world, the same person might be "John" in one context, "JohnDoe123" in another, and "@john" in a third. The metadata field is completely flexible, not prescribing what data an entity should have. And the components array introduces a powerful new concept we'll explore later.

Let me show you how to migrate actual code. Here's a function from an old plugin:

```typescript
// Old code assuming users
async function greetUser(runtime: IAgentRuntime, userId: UUID) {
  const account = await runtime.getAccountById(userId);
  if (account) {
    return `Hello, ${account.name}! Welcome back.`;
  }
  return 'Hello, stranger!';
}
```

Here's how you'd rewrite it for the new system:

```typescript
// New code thinking in entities
async function greetEntity(runtime: IAgentRuntime, entityId: UUID) {
  const entity = await runtime.getEntityById(entityId);
  if (entity && entity.names.length > 0) {
    // Use the first name, or you could be smarter about choosing
    return `Hello, ${entity.names[0]}! Welcome back.`;
  }
  return 'Hello there!';
}
```

But the real power comes when you stop thinking about "greeting users" and start thinking about "greeting entities":

```typescript
// Even better: truly entity-agnostic code
async function greetEntity(runtime: IAgentRuntime, entityId: UUID) {
  const entity = await runtime.getEntityById(entityId);
  const relationship = await runtime.getRelationship({
    sourceEntityId: runtime.agentId,
    targetEntityId: entityId,
  });

  if (relationship?.metadata?.nickname) {
    // We have a special nickname for this entity
    return `Hey ${relationship.metadata.nickname}! Good to see you.`;
  } else if (entity && entity.names.length > 0) {
    // Use their known name
    return `Hello, ${entity.names[0]}! Welcome.`;
  } else {
    // We don't know this entity yet
    return "Hello! I don't think we've met. What should I call you?";
  }
}
```

This code works whether the entity is a human, another AI agent, or even a bot. It doesn't need to know or care.

### Step 4: Transforming Clients into Services

Now let's tackle one of the most significant architectural changes: converting clients into services. This change reflects a deeper understanding of what these components really do in the system.

In the old system, a client was simple:

```typescript
const discordClient = {
  name: 'discord',
  start: async (runtime) => {
    // Set up Discord connection
    const client = new DiscordClient();
    await client.login(token);

    return {
      stop: async () => {
        await client.destroy();
      },
    };
  },
};
```

This worked, but it was limited. The client was passive, just a connection. In the new system, we recognize that these components are active services providing capabilities:

```typescript
export class DiscordService extends Service {
  static serviceType = 'discord'; // Unique identifier
  capabilityDescription = 'Provides Discord messaging capabilities';

  private client: DiscordClient;
  private messageQueue: MessageQueue;
  private rateLimiter: RateLimiter;

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
    // Services can have complex internal state
    this.messageQueue = new MessageQueue();
    this.rateLimiter = new RateLimiter();
  }

  static async start(runtime: IAgentRuntime): Promise<DiscordService> {
    const service = new DiscordService(runtime);

    // Services handle their own initialization
    service.client = new DiscordClient({
      intents: service.determineRequiredIntents(),
    });

    // Services manage their own event handling
    service.setupEventHandlers();

    // Services can do complex startup procedures
    await service.client.login(runtime.getSetting('DISCORD_TOKEN'));
    await service.loadServerConfigurations();
    await service.initializeMessageQueues();

    return service;
  }

  async stop(): Promise<void> {
    // Services handle graceful shutdown
    await this.messageQueue.flush();
    await this.saveState();
    await this.client.destroy();
  }

  // Services can expose methods for other parts of the system
  async sendMessage(channelId: string, content: string) {
    await this.rateLimiter.waitIfNeeded();
    await this.messageQueue.add({
      channelId,
      content,
      priority: this.calculatePriority(content),
    });
  }

  private setupEventHandlers() {
    this.client.on('messageCreate', async (message) => {
      // Services emit runtime events instead of handling directly
      await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: this.convertDiscordMessage(message),
        source: 'discord',
      });
    });
  }
}
```

See how much richer this is? The service manages its own state, handles its own initialization, provides methods for other components to use, and manages its own cleanup. It's a first-class citizen in the system, not just a connection wrapper.

### Step 5: Making Your Plugin Self-Sufficient

One of the biggest changes in 1.x is that plugins must be self-sufficient. The runtime no longer provides utility functions for things like JSON parsing, text processing, or API calls. This might seem like more work, but it gives you freedom to implement things exactly as your plugin needs.

Let me show you what this means in practice. In the old system, you might have written:

```typescript
import { parseJSON, validateJSON, formatResponse } from '@elizaos/core';

async function handleUserInput(input: string) {
  const parsed = parseJSON(input); // Runtime utility
  if (validateJSON(parsed, schema)) {
    // Runtime utility
    const response = await processInput(parsed);
    return formatResponse(response); // Runtime utility
  }
}
```

In the new system, you need to provide these utilities yourself:

```typescript
// In your plugin's utils.ts file
export function parseJSON(input: string): any {
  try {
    // You control exactly how JSON is parsed
    return JSON.parse(input);
  } catch (error) {
    // You control error handling
    console.error('Failed to parse JSON:', error);
    return null;
  }
}

export function validateAgainstSchema(data: any, schema: Schema): boolean {
  // Implement your own validation logic
  // Maybe use a library like Zod or Yup
  // You choose what works best for your plugin
}

// Now your handler is self-contained
async function handleUserInput(input: string) {
  const parsed = parseJSON(input); // Your utility
  if (validateAgainstSchema(parsed, schema)) {
    // Your utility
    const response = await processInput(parsed);
    return formatResponse(response); // Your formatting logic
  }
}
```

This might seem like extra work, but consider the benefits. Your plugin no longer depends on the runtime's idea of how JSON should be parsed. You can handle errors exactly as your plugin needs. You can use whatever validation library you prefer. You're in control.

### Step 6: Understanding the New Model System

Perhaps the most significant change in plugin empowerment is how models are handled. In 0.x, the runtime knew how to call various AI models. In 1.x, plugins bring their own model implementations.

Let me walk you through this transformation. In the old system, when you wanted to generate text, you'd do this:

```typescript
const response = await generateText({
  runtime: runtime,
  context: 'Write a story about a brave knight',
  modelClass: ModelClass.LARGE,
});
```

The runtime would figure out which AI provider to use based on configuration. But this was limiting. What if you wanted to use a new AI provider the runtime didn't know about? What if you wanted to route different requests to different models based on complex logic? You were stuck with what the runtime provided.

In the new system, your plugin registers handlers for different model types:

```typescript
export const myAIPlugin: Plugin = {
  name: 'my-ai-plugin',
  models: {
    [ModelType.TEXT_LARGE]: async (runtime, params) => {
      // Your plugin decides everything about how to handle this

      // Maybe you check the prompt and route to different models
      if (params.prompt.includes('code')) {
        return await callCodeSpecializedModel(params);
      } else if (params.prompt.includes('creative')) {
        return await callCreativeModel(params);
      } else {
        return await callGeneralModel(params);
      }
    },

    [ModelType.TEXT_EMBEDDING]: async (runtime, params) => {
      // Your embedding logic
      // Maybe you use a local model for privacy
      // Maybe you batch requests for efficiency
      // You're in complete control
    },
  },
};
```

When code calls `runtime.useModel()`, the runtime just delegates to whatever plugin registered a handler. This is powerful because:

- You can use any AI provider, not just ones the runtime knows about
- You can implement complex routing logic
- You can add caching, rate limiting, or any other features
- You can even use local models without internet access

### Step 7: Mastering the Memory System Changes

The memory system in 1.x has evolved to be more explicit and powerful. The biggest change is that you must now specify which table you're working with. This isn't bureaucracy; it's clarity.

In the old system, different manager objects handled different types of memories:

```typescript
// Old way - implicit table selection
await runtime.messageManager.createMemory(message);
await runtime.documentManager.createMemory(document);
await runtime.factManager.createMemory(fact);
```

The problem was that you were limited to the manager objects the runtime provided. What if you wanted a custom table for your plugin's specific needs? You couldn't have one.

In the new system, you explicitly specify the table:

```typescript
// New way - explicit table selection
await runtime.createMemory(message, 'messages');
await runtime.createMemory(document, 'documents');
await runtime.createMemory(fact, 'facts');

// And you can create custom tables!
await runtime.createMemory(customData, 'my_plugin_special_table');
```

This explicitness has several benefits. You can see at a glance which table is being used. You can create custom tables for your plugin's needs. And the runtime doesn't need to maintain a growing list of manager objects.

Another major change is how embeddings are handled. In the old system, you had to manage embeddings manually:

```typescript
// Old way - manual embedding management
const embedding = await runtime.getEmbedding(text);
const memory = {
  content: { text: 'Hello world' },
  embedding: embedding, // You had to set this
  userId: userId,
  roomId: roomId,
};
await runtime.messageManager.createMemory(memory);
```

In the new system, the runtime handles embeddings automatically:

```typescript
// New way - automatic embedding generation
const memory = {
  content: { text: 'Hello world' },
  // No embedding field needed!
  entityId: entityId,
  roomId: roomId,
};
await runtime.createMemory(memory, 'messages');
// The runtime generates the embedding for you
```

This is simpler and ensures embeddings are generated consistently across all plugins.

### Step 8: Embracing the Task System

One of the exciting new features in 1.x is the task system. This didn't exist in 0.x at all, and it opens up powerful new possibilities for your plugins.

Tasks allow you to schedule work for later, create recurring operations, or even build interactive workflows. Think of tasks as "todos" for your agent that persist across restarts and can be processed when appropriate.

Let me show you how to use this powerful new system. First, you need to register a task worker:

```typescript
runtime.registerTaskWorker({
  name: 'WEEKLY_SUMMARY',

  validate: async (runtime, message, state) => {
    // Decide if this task type is appropriate
    return state.summariesEnabled;
  },

  execute: async (runtime, options, task) => {
    // The actual work of the task
    const summary = await generateWeeklySummary(runtime, task.roomId);

    // Create a message with the summary
    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        roomId: task.roomId,
        content: {
          text: `Here's your weekly summary:\n\n${summary}`,
          attachments: [
            {
              type: 'document',
              content: detailedSummary,
            },
          ],
        },
      },
      'messages'
    );

    // For recurring tasks, we don't delete them
    // For one-time tasks, we would delete after execution
  },
});
```

Now you can create tasks that use this worker:

```typescript
// Create a recurring weekly task
await runtime.createTask({
  name: 'WEEKLY_SUMMARY',
  description: 'Generate and post weekly summary',
  roomId: channelId,
  worldId: worldId,
  tags: ['summary', 'recurring', 'weekly'],
  metadata: {
    updateInterval: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
    updatedAt: Date.now(),
    includeStats: true,
    mentionRole: '@everyone',
  },
});
```

The task system also supports interactive workflows:

```typescript
// Create a task that waits for user input
await runtime.createTask({
  name: 'APPROVAL_REQUIRED',
  description: 'Waiting for manager approval',
  roomId: message.roomId,
  tags: ['approval', 'AWAITING_CHOICE'],
  metadata: {
    options: [
      { name: 'approve', description: 'Approve the request' },
      { name: 'deny', description: 'Deny the request' },
      { name: 'defer', description: 'Decide later' },
    ],
    requestType: 'BUDGET_INCREASE',
    amount: 50000,
    requester: message.entityId,
  },
});
```

Tasks can be as simple or complex as you need. They can coordinate multi-step workflows, handle time-based operations, or manage interactive conversations that span multiple messages.

### Step 9: Understanding Worlds and Rooms

The introduction of "worlds" is another new concept in 1.x. Think of worlds as containers for rooms, adding a hierarchical organization that reflects how platforms actually work.

In the old system, rooms were standalone:

```typescript
// Old way - rooms without context
const roomId = await runtime.createRoom();
await runtime.addParticipant(userId, roomId);
```

In the new system, rooms exist within worlds:

```typescript
// New way - rooms within worlds
// First, ensure the world exists
await runtime.ensureWorldExists({
  id: worldId,
  name: 'My Discord Server',
  agentId: runtime.agentId,
  serverId: 'discord-1234567890',
  metadata: {
    platform: 'discord',
    createdBy: 'user-123',
    purpose: 'Community for AI enthusiasts',
  },
});

// Then create rooms within that world
await runtime.createRoom({
  id: roomId,
  name: 'general-chat',
  worldId: worldId, // Rooms belong to worlds
  source: 'discord',
  type: ChannelType.GROUP,
  channelId: 'discord-channel-id',
});
```

This hierarchical structure better represents reality. On Discord, channels (rooms) exist within servers (worlds). On Slack, channels exist within workspaces. This structure allows for world-level permissions, settings, and organization.

### Step 10: Migrating Your Tests

Testing is crucial for a successful migration, and the move from Jest to Vitest brings some changes. Vitest is faster and more modern, but the syntax is very similar to Jest, making migration straightforward.

Here's how to migrate a typical test:

```typescript
// Old Jest test
import { generateText } from '@elizaos/core';

describe('My Plugin', () => {
  it('should generate text correctly', async () => {
    const mockRuntime = {
      getSetting: jest.fn().mockReturnValue('api-key'),
    };

    const result = await generateText({
      runtime: mockRuntime,
      context: 'Hello',
      modelClass: ModelClass.SMALL,
    });

    expect(result).toBeDefined();
    expect(result).toContain('response');
  });
});
```

Here's the Vitest version:

```typescript
// New Vitest test
import { describe, it, expect, vi } from 'vitest';
import { myPlugin } from '../index';

describe('My Plugin', () => {
  it('should handle model calls correctly', async () => {
    // Vitest uses 'vi' instead of 'jest' for mocks
    const mockRuntime = {
      getSetting: vi.fn((key) => {
        if (key === 'API_KEY') return 'test-key';
        return null;
      }),
    };

    // Test your model handler directly
    const handler = myPlugin.models[ModelType.TEXT_SMALL];
    const result = await handler(mockRuntime, {
      prompt: 'Hello',
      temperature: 0.7,
    });

    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('should register services correctly', async () => {
    const mockRuntime = {
      // Mock the methods your service needs
      getSetting: vi.fn(),
      emitEvent: vi.fn(),
    };

    // Test service lifecycle
    const MyService = myPlugin.services[0];
    const instance = await MyService.start(mockRuntime);

    expect(instance).toBeDefined();
    expect(instance.capabilityDescription).toBeDefined();

    // Test cleanup
    await instance.stop();
    // Verify cleanup happened
  });
});
```

The key differences are:

- Import mocking utilities from 'vitest' instead of using global Jest functions
- Use `vi` instead of `jest` for mocking
- Test your plugin's components directly rather than testing runtime functions

## Part 3: Putting It All Together

Now that we've covered all the major changes, let's walk through a complete migration example. We'll take a hypothetical weather plugin from 0.x to 1.x.

### The Original 0.x Plugin

Here's what our weather plugin looked like in 0.x:

```typescript
import { Plugin, Action, generateText, elizaLogger } from '@elizaos/core';

const getWeatherAction: Action = {
  name: 'GET_WEATHER',
  similes: ['CHECK_WEATHER', 'WEATHER_REPORT'],
  description: 'Get weather for a location',

  handler: async (runtime, message, state) => {
    const location = extractLocation(message.content.text);

    elizaLogger.info(`Getting weather for ${location}`);

    const weatherData = await fetchWeather(location);

    const response = await generateText({
      runtime,
      context: `Describe this weather: ${JSON.stringify(weatherData)}`,
      modelClass: ModelClass.SMALL,
    });

    await runtime.messageManager.createMemory({
      userId: message.userId,
      roomId: message.roomId,
      content: {
        text: response,
        action: 'GET_WEATHER',
      },
    });

    return true;
  },

  validate: async (runtime, message) => {
    return message.content.text.includes('weather');
  },
};

export const weatherPlugin: Plugin = {
  name: 'weather',
  actions: [getWeatherAction],
  clients: [
    {
      name: 'weather-updates',
      start: async (runtime) => {
        const interval = setInterval(async () => {
          // Post weather updates
        }, 3600000);

        return {
          stop: async () => clearInterval(interval),
        };
      },
    },
  ],
};
```

### The Migrated 1.x Plugin

Here's the same plugin migrated to 1.x:

```typescript
import {
  Plugin,
  Action,
  Service,
  ModelType,
  EventType,
  logger, // renamed from elizaLogger
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  UUID,
} from '@elizaos/core';

// First, let's create our own utilities since runtime doesn't provide them
function extractLocation(text: string): string {
  // Our own location extraction logic
  const match = text.match(/weather (?:in|for) ([a-zA-Z\s]+)/i);
  return match ? match[1].trim() : 'current location';
}

async function fetchWeather(location: string): Promise<WeatherData> {
  // Our own weather fetching logic
  const response = await fetch(`https://api.weather.com/v1/weather?q=${location}`);
  return response.json();
}

// Convert the client to a service
class WeatherUpdateService extends Service {
  static serviceType = 'weather-updates';
  capabilityDescription = 'Provides periodic weather updates';

  private updateInterval: NodeJS.Timer | null = null;

  static async start(runtime: IAgentRuntime): Promise<WeatherUpdateService> {
    const service = new WeatherUpdateService();
    service.runtime = runtime;

    // Services manage their own initialization
    service.updateInterval = setInterval(async () => {
      // Find rooms that want weather updates
      const rooms = await service.getRoomsWithWeatherUpdates();

      for (const roomId of rooms) {
        const weather = await fetchWeather('local');

        // Create a memory for the update
        await runtime.createMemory(
          {
            entityId: runtime.agentId, // Changed from userId
            roomId: roomId,
            content: {
              text: `Weather update: ${weather.description}`,
              metadata: { weather },
            },
          },
          'messages'
        ); // Explicit table name
      }
    }, 3600000);

    logger.info('Weather update service started');
    return service;
  }

  async stop(): Promise<void> {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    logger.info('Weather update service stopped');
  }

  private async getRoomsWithWeatherUpdates(): Promise<UUID[]> {
    // Service manages its own data
    // Could query a custom table or check room metadata
    return [];
  }
}

// Update the action for 1.x
const getWeatherAction: Action = {
  name: 'GET_WEATHER',
  similes: ['CHECK_WEATHER', 'WEATHER_REPORT'],
  description: 'Get weather for a location',

  handler: async (
    runtime: IAgentRuntime,
    message: Memory, // Still called Memory
    state?: State,
    options?: any,
    callback?: HandlerCallback // New callback parameter
  ) => {
    const location = extractLocation(message.content.text);

    logger.info(`Getting weather for ${location}`); // logger instead of elizaLogger

    const weatherData = await fetchWeather(location);

    // Plugin must handle its own text generation
    // since runtime doesn't provide generateText
    const prompt = `Describe this weather in a friendly way: ${JSON.stringify(weatherData)}`;

    // Use the new model system
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: prompt,
      temperature: 0.7,
    });

    // Use the callback to send response
    if (callback) {
      await callback({
        text: response,
        thought: `User asked about weather in ${location}`,
        actions: ['GET_WEATHER'], // Now an array
      });
    }

    return true;
  },

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    return message.content.text?.toLowerCase().includes('weather') ?? false;
  },
};

// Register model handlers for our plugin
const modelHandlers = {
  // Our plugin can provide specialized weather descriptions
  [ModelType.TEXT_SMALL]: async (runtime: IAgentRuntime, params: any) => {
    if (params.prompt.includes('weather')) {
      // Special handling for weather-related prompts
      return `The weather looks ${params.prompt.includes('rain') ? 'wet' : 'pleasant'}!`;
    }
    // Delegate to another provider for non-weather content
    return null;
  },
};

// Create a task worker for scheduled weather reports
runtime.registerTaskWorker({
  name: 'DAILY_WEATHER_REPORT',
  execute: async (runtime, options, task) => {
    const weather = await fetchWeather(options.location || 'local');

    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        roomId: task.roomId,
        content: {
          text: `Good morning! Today's weather: ${weather.description}`,
          metadata: { weather, type: 'daily-report' },
        },
      },
      'messages'
    );
  },
});

// The migrated plugin
export const weatherPlugin: Plugin = {
  name: 'weather',
  description: 'Provides weather information and updates',

  actions: [getWeatherAction],

  services: [WeatherUpdateService], // Services instead of clients

  models: modelHandlers, // New: plugin provides model handlers

  // New: plugin can handle events
  events: {
    [EventType.MESSAGE_RECEIVED]: [
      async (payload) => {
        // Check if message mentions weather
        if (payload.message.content.text?.includes('weather alert')) {
          // Handle weather alerts specially
        }
      },
    ],
  },
};
```

Look at how much more capable the 1.x version is! The plugin:

- Manages its own utilities and logic
- Provides a proper service with lifecycle management
- Can register its own model handlers
- Can respond to system events
- Works with entities instead of users
- Uses the explicit table-based memory system
- Can leverage the task system for scheduled reports

## Part 4: Common Challenges and Solutions

As you work through your migration, you'll likely encounter some common challenges. Let me help you navigate these.

### Challenge 1: "I can't find the utility function I need!"

This is the most common issue. You're looking for `generateText` or `parseJSON` or some other utility the runtime used to provide. The solution is to embrace your plugin's independence.

Instead of searching for a runtime utility, ask yourself: "What does my plugin actually need to do here?" Then implement exactly that. You'll often find that your custom implementation is simpler and more appropriate for your specific needs than the generic runtime utility was.

### Challenge 2: "The entity system seems more complex"

It might seem that way at first, but it's actually simpler once you embrace it. Instead of thinking "Is this a user or an agent?", just think "This is an entity." Your code becomes cleaner because you're not constantly branching based on what type of participant you're dealing with.

### Challenge 3: "Setting up services feels like boilerplate"

The service structure might feel like extra ceremony compared to the old client system. But this structure brings real benefits: proper lifecycle management, better error handling, cleaner shutdown, and the ability to expose capabilities to other parts of the system. The "boilerplate" is actually establishing important contracts that make your plugin more robust.

### Challenge 4: "I don't understand when to use tasks"

Think of tasks as "deferred actions" or "persistent todos." Use them when:

- You need something to happen later (like a reminder)
- You need something to happen repeatedly (like daily reports)
- You need to wait for user input before proceeding
- You need to coordinate a multi-step workflow

If the action needs to happen immediately in response to a message, you don't need a task. If it needs to happen later, repeatedly, or conditionally, tasks are your friend.

### Challenge 5: "I'm not sure how the agent receives and handles messages"

This is a common source of confusion because the message handling system has been completely redesigned. In 0.x, messages were handled through a single pipeline. In 1.x, we use a more flexible event-based system.

Here's how it works:

1.  **Service Ingestion**: A `Service` (like `DiscordService` or a custom service your plugin provides) is responsible for connecting to an external platform (e.g., Discord, Slack, a web chat). When a new message arrives from that platform, the Service ingests it.

2.  **Message Normalization**: The Service's job is to translate the platform-specific message format into a standardized Eliza `Memory` object. This involves:

    - Identifying or creating an `entityId` for the sender.
    - Identifying or creating `roomId` and `worldId` for where the message originated.
    - Extracting the content (text, attachments, etc.).
    - Potentially adding platform-specific metadata.

3.  **Event Emission**: Once the message is normalized into a `Memory` object, the Service emits a core runtime event, typically `EventType.MESSAGE_RECEIVED`. The payload of this event includes the `Memory` object and other relevant context, like the `runtime` instance and the `source` (e.g., 'discord').

    ```typescript
    // Inside a Service, after receiving and normalizing a message
    await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      runtime: this.runtime,
      message: normalizedMessage, // This is a Memory object
      source: 'my-platform-name',
    });
    ```

4.  **Runtime Catches Event**: The Eliza runtime is listening for these core events. When `EventType.MESSAGE_RECEIVED` is emitted, the runtime catches it.

5.  **Plugin Event Handlers (Optional)**: If your plugin (or any other active plugin) has registered an event handler for `EventType.MESSAGE_RECEIVED`, that handler will be executed. This allows plugins to react to messages directly, perhaps for logging, custom pre-processing, or triggering side effects _before_ an action is even considered.

    ```typescript
    // In your plugin definition
    export const myPlugin: Plugin = {
      // ... other properties
      events: {
        [EventType.MESSAGE_RECEIVED]: [
          async (payload) => {
            logger.info(`Plugin saw message from: ${payload.message.entityId}`);
            // Maybe add some metadata to the message if needed,
            // or decide to stop further processing for some reason.
          },
        ],
      },
    };
    ```

6.  **Action Validation**: After event handlers have had a chance to run, the runtime takes the `Memory` object (the message) and presents it to all registered `Action` components from all active plugins. Each `Action` has a `validate` function that determines if that action is relevant or applicable to the current message and context.

7.  **Action Selection (LLM)**: All actions that return `true` from their `validate` function are considered "valid" for the current message. This list of valid actions is then typically passed to a Language Model (LLM) through an `actionsProvider`. The LLM's role is to decide which _specific_ action (or actions) should be executed in response to the message.

8.  **Action Execution**: The runtime then executes the `handler` function of the action(s) chosen by the LLM. This is where your plugin's core logic for responding to a message resides.

    ```typescript
    // Inside an Action's handler
    handler: async (runtime, message, state, options, callback) => {
      // Process the message, call APIs, use models, etc.
      const responseText = "This is the agent's reply.";

      // Use the callback to send the response
      if (callback) {
        await callback({
          text: responseText,
          thought: "I have processed the user's message and generated a reply.",
        });
      }
      return true;
    };
    ```

9.  **Generating a Response**: The action handler is responsible for generating a response. This usually involves:

    - Crafting the reply text and any other content (e.g., attachments).
    - Optionally, providing a "thought" – an explanation of the agent's reasoning.
    - Using the `callback` function (passed to the `handler`) to send the response back through the runtime.

10. **Response Delivery**: When the `callback` is invoked by an action handler, the runtime takes the response. This typically involves creating a new `Memory` object for the agent's reply and persisting it. Then, an event like `EventType.MESSAGE_SEND` (or a similar custom event) might be emitted. The original `Service` (or another `Service` responsible for outgoing messages) listens for these events, picks up the agent's reply, translates it back into the platform-specific format, and sends it to the user on the external platform.

This event-driven flow is much more flexible than the 0.x pipeline. It allows:

- **Decoupling**: Services don't need to know about specific actions, and actions don't need to know about specific services. They communicate through events and standardized data structures.
- **Extensibility**: Plugins can easily hook into the message flow by listening for and emitting events, or by providing new actions and services.
- **Clarity**: The flow of data (message in -> events -> validation -> selection -> execution -> response out) is more explicit.

So, when a message comes in, your `Service` turns it into an `Event`. `Actions` (and other event listeners) react to that `Event`. The chosen `Action` then does its job and (usually) produces a response, which itself might become part of another `Event` that a `Service` uses to send the reply.

## Part 5: Final Thoughts and Best Practices

As we conclude this journey, let me leave you with some key insights and best practices for your migration.

### Test Continuously

Set up your tests early and run them often. The new test structure with Vitest makes it easy to test individual components of your plugin. Test your service lifecycle, your model handlers, your action handlers, and your event handlers independently.

### Use Types Effectively

TypeScript is your friend in this migration. The new type system is more sophisticated and will catch many errors at compile time. Don't use `any` to bypass type errors; instead, understand what the correct type should be.

### Use the Autoupgrader

You can auto-upgrade your plugin with the CLI! Just run `elizaos plugin upgrade <path>` (you will need the CLI installed, or append `npx` to the front of the command like `npx elizaos ...`)

This is experimental and not guaranteed, especially with complex plugins, but it may get you most of the way there. We suggest reading through and understanding the migration fundamentals in detail while the auto upgrader is running so you can help it get to completion.

### Ask for Help

The Eliza community is friendly and helpful. If you're stuck on something, ask in the Discord. Share what you've tried and what isn't working. Often, someone else has faced the same challenge and found a solution.

For additional help, refer to:

- The example plugins in the Eliza repository
- The plugin registry for real-world examples
- The Eliza Discord community for support

Good luck with your migration!
