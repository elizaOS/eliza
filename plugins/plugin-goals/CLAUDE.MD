# ElizaOS Types Reference

This document provides a comprehensive reference for all core types and interfaces used throughout ElizaOS.

## Agent & Character Types

### Character

Defines an agent's personality, knowledge, and capabilities.

```typescript
interface Character {
  id?: UUID;
  name: string;
  username?: string;
  system?: string; // System prompt
  templates?: { [key: string]: TemplateType }; // Prompt templates
  bio: string | string[];
  messageExamples?: MessageExample[][];
  postExamples?: string[];
  topics?: string[];
  adjectives?: string[];
  knowledge?: (string | { path: string; shared?: boolean } | DirectoryItem)[];
  plugins?: string[];
  settings?: { [key: string]: any };
  secrets?: { [key: string]: string | boolean | number };
  style?: {
    all?: string[];
    chat?: string[];
    post?: string[];
  };
}
```

### Agent

Extends Character with runtime status.

```typescript
interface Agent extends Character {
  enabled?: boolean;
  status?: AgentStatus;
  createdAt: number;
  updatedAt: number;
}

enum AgentStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}
```

## Component System Types

### Action

Defines agent capabilities and response mechanisms.

```typescript
interface Action {
  name: string;
  similes?: string[];
  description: string;
  examples?: ActionExample[][];
  handler: Handler;
  validate: Validator;
  effects?: {
    provides: string[];
    requires: string[];
    modifies: string[];
  };
  estimateCost?: (params: any) => number;
}
```

### Provider

Sources of information for agents.

```typescript
interface Provider {
  name: string;
  description?: string;
  dynamic?: boolean; // Only used when requested
  position?: number; // Execution order
  private?: boolean; // Must be explicitly included
  get: (runtime: IAgentRuntime, message: Memory, state: State) => Promise<ProviderResult>;
}

interface ProviderResult {
  values?: { [key: string]: any };
  data?: { [key: string]: any };
  text?: string;
}
```

### Evaluator

Post-processing cognitive components.

```typescript
interface Evaluator {
  alwaysRun?: boolean;
  description: string;
  similes?: string[];
  examples: EvaluationExample[];
  handler: Handler;
  name: string;
  validate: Validator;
}
```

### Service

Long-running stateful components.

```typescript
abstract class Service {
  static serviceName: string;
  static serviceType?: ServiceTypeName;
  serviceName: string;
  abstract capabilityDescription: string;
  config?: Metadata;

  abstract stop(): Promise<void>;
  static async start(runtime: IAgentRuntime): Promise<Service>;
}
```

## Environment Types

### Entity

Represents users, agents, or participants.

```typescript
interface Entity {
  id?: UUID;
  names: string[];
  metadata?: Metadata;
  agentId: UUID;
  components?: Component[];
}
```

### Component

Modular data attached to entities.

```typescript
interface Component {
  id: UUID;
  entityId: UUID;
  agentId: UUID;
  roomId: UUID;
  worldId: UUID;
  sourceEntityId: UUID;
  type: string;
  createdAt: number;
  data: Metadata;
}
```

### World

Collections of entities and rooms.

```typescript
type World = {
  id: UUID;
  name?: string;
  agentId: UUID;
  serverId: string;
  metadata?: {
    ownership?: { ownerId: string };
    roles?: { [entityId: UUID]: Role };
    [key: string]: unknown;
  };
};

enum Role {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  NONE = 'NONE',
}
```

### Room

Individual interaction spaces.

```typescript
type Room = {
  id: UUID;
  name?: string;
  agentId?: UUID;
  source: string;
  type: ChannelType;
  channelId?: string;
  serverId?: string;
  worldId?: UUID;
  metadata?: Metadata;
};

enum ChannelType {
  SELF = 'SELF',
  DM = 'DM',
  GROUP = 'GROUP',
  VOICE_DM = 'VOICE_DM',
  VOICE_GROUP = 'VOICE_GROUP',
  FEED = 'FEED',
  THREAD = 'THREAD',
  WORLD = 'WORLD',
  FORUM = 'FORUM',
  API = 'API', // @deprecated
}
```

### Relationship

Connections between entities.

```typescript
interface Relationship {
  id: UUID;
  sourceEntityId: UUID;
  targetEntityId: UUID;
  agentId: UUID;
  tags: string[];
  metadata: Metadata;
  createdAt?: string;
  relationshipType?: string;
  strength?: number;
  lastInteractionAt?: string;
  nextFollowUpAt?: string;
}
```

## Memory Types

### Memory

Core memory/message structure.

```typescript
interface Memory {
  id?: UUID;
  entityId: UUID;
  agentId?: UUID;
  createdAt?: number;
  content: Content;
  embedding?: number[];
  roomId: UUID;
  worldId?: UUID;
  unique?: boolean;
  similarity?: number;
  metadata?: MemoryMetadata;
}
```

### Content

Message content structure.

```typescript
interface Content {
  thought?: string; // Agent's internal thought
  text?: string; // Main text content
  actions?: string[]; // Actions to perform
  providers?: string[]; // Providers to use
  source?: string;
  target?: string;
  url?: string;
  inReplyTo?: UUID;
  attachments?: Media[];
  channelType?: string;
  [key: string]: unknown;
}
```

### Memory Metadata Types

```typescript
enum MemoryType {
  DOCUMENT = 'document',
  FRAGMENT = 'fragment',
  MESSAGE = 'message',
  DESCRIPTION = 'description',
  CUSTOM = 'custom',
}

type MemoryScope = 'shared' | 'private' | 'room';

interface BaseMetadata {
  type: MemoryTypeAlias;
  source?: string;
  sourceId?: UUID;
  scope?: MemoryScope;
  timestamp?: number;
  tags?: string[];
}
```

## Planning & Execution Types

### ActionResult

Result of action execution for chaining.

```typescript
interface ActionResult {
  values?: { [key: string]: any };
  data?: { [key: string]: any };
  text?: string;
}
```

### ActionContext

Context provided during action execution.

```typescript
interface ActionContext {
  planId?: UUID;
  stepId?: UUID;
  workingMemory?: WorkingMemory;
  previousResults?: ActionResult[];
  abortSignal?: AbortSignal;
  updateMemory?: (key: string, value: any) => void;
  getMemory?: (key: string) => any;
  getPreviousResult?: (stepId: UUID) => ActionResult | undefined;
  requestReplanning?: () => Promise<ActionPlan>;
}
```

### Task

Deferred or scheduled operations.

```typescript
interface Task {
  id?: UUID;
  name: string;
  updatedAt?: number;
  metadata?: TaskMetadata;
  description: string;
  roomId?: UUID;
  worldId?: UUID;
  entityId?: UUID;
  tags: string[];
}

type TaskMetadata = {
  updateInterval?: number; // For recurring tasks
  options?: {
    // For choice tasks
    name: string;
    description: string;
  }[];
  [key: string]: unknown;
};
```

## State Types

### State

Current conversation context.

```typescript
interface State {
  values: { [key: string]: any };
  data: { [key: string]: any };
  text: string;
  [key: string]: any;
}
```

## Model Types

### ModelType

Available model categories.

```typescript
const ModelType = {
  TEXT_SMALL: 'TEXT_SMALL',
  TEXT_LARGE: 'TEXT_LARGE',
  TEXT_EMBEDDING: 'TEXT_EMBEDDING',
  TEXT_TOKENIZER_ENCODE: 'TEXT_TOKENIZER_ENCODE',
  TEXT_TOKENIZER_DECODE: 'TEXT_TOKENIZER_DECODE',
  TEXT_REASONING_SMALL: 'REASONING_SMALL',
  TEXT_REASONING_LARGE: 'REASONING_LARGE',
  TEXT_COMPLETION: 'TEXT_COMPLETION',
  IMAGE: 'IMAGE',
  IMAGE_DESCRIPTION: 'IMAGE_DESCRIPTION',
  TRANSCRIPTION: 'TRANSCRIPTION',
  TEXT_TO_SPEECH: 'TEXT_TO_SPEECH',
  AUDIO: 'AUDIO',
  VIDEO: 'VIDEO',
  OBJECT_SMALL: 'OBJECT_SMALL',
  OBJECT_LARGE: 'OBJECT_LARGE',
} as const;
```

## Event Types

### EventType

Standard event types across platforms.

```typescript
enum EventType {
  // World events
  WORLD_JOINED = 'WORLD_JOINED',
  WORLD_CONNECTED = 'WORLD_CONNECTED',
  WORLD_LEFT = 'WORLD_LEFT',

  // Entity events
  ENTITY_JOINED = 'ENTITY_JOINED',
  ENTITY_LEFT = 'ENTITY_LEFT',
  ENTITY_UPDATED = 'ENTITY_UPDATED',

  // Room events
  ROOM_JOINED = 'ROOM_JOINED',
  ROOM_LEFT = 'ROOM_LEFT',

  // Message events
  MESSAGE_RECEIVED = 'MESSAGE_RECEIVED',
  MESSAGE_SENT = 'MESSAGE_SENT',
  MESSAGE_DELETED = 'MESSAGE_DELETED',

  // Other events...
}
```

## Plugin Types

### Plugin

Extension interface for agent functionality.

```typescript
interface Plugin {
  name: string;
  description: string;
  init?: (config: Record<string, string>, runtime: IAgentRuntime) => Promise<void>;
  config?: { [key: string]: any };
  services?: (typeof Service)[];
  componentTypes?: {
    name: string;
    schema: Record<string, unknown>;
    validator?: (data: any) => boolean;
  }[];
  actions?: Action[];
  providers?: Provider[];
  evaluators?: Evaluator[];
  adapter?: IDatabaseAdapter;
  models?: { [key: string]: (...args: any[]) => Promise<any> };
  events?: PluginEvents;
  routes?: Route[];
  tests?: TestSuite[];
  dependencies?: string[];
  testDependencies?: string[];
  priority?: number;
  schema?: any;
}
```

## Runtime Interface

### IAgentRuntime

Core runtime environment for agents.

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

  // Core methods
  registerPlugin(plugin: Plugin): Promise<void>;
  initialize(): Promise<void>;
  getService<T extends Service>(service: ServiceTypeName | string): T | null;
  composeState(
    message: Memory,
    includeList?: string[],
    onlyInclude?: boolean,
    skipCache?: boolean
  ): Promise<State>;
  useModel<T extends ModelTypeName, R = ModelResultMap[T]>(
    modelType: T,
    params: Omit<ModelParamsMap[T], 'runtime'> | any
  ): Promise<R>;
  processActions(
    message: Memory,
    responses: Memory[],
    state?: State,
    callback?: HandlerCallback
  ): Promise<void>;
  evaluate(
    message: Memory,
    state?: State,
    didRespond?: boolean,
    callback?: HandlerCallback,
    responses?: Memory[]
  ): Promise<Evaluator[] | null>;

  // Task methods
  registerTaskWorker(taskHandler: TaskWorker): void;
  getTaskWorker(name: string): TaskWorker | undefined;

  // And many more...
}
```

## Handler & Callback Types

### Handler

Core handler function type.

```typescript
type Handler = (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  options?: { [key: string]: unknown },
  callback?: HandlerCallback,
  responses?: Memory[]
) => Promise<ActionResult | void | boolean | null>;
```

### HandlerCallback

Response callback function.

```typescript
type HandlerCallback = (response: Content, files?: any) => Promise<Memory[]>;
```

### Validator

Validation function type.

```typescript
type Validator = (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<boolean>;
```

## Primitive Types

### UUID

Universally unique identifier.

```typescript
type UUID = `${string}-${string}-${string}-${string}-${string}`;

function asUUID(id: string): UUID; // Helper to cast string to UUID
```

### Metadata

Generic metadata object.

```typescript
type Metadata = Record<string, unknown>;
```

## Testing Types

### TestSuite & TestCase

Testing infrastructure types.

```typescript
interface TestCase {
  name: string;
  fn: (runtime: IAgentRuntime) => Promise<void> | void;
}

interface TestSuite {
  name: string;
  tests: TestCase[];
}
```

## Service Types

### ServiceType

Available service categories.

```typescript
const ServiceType = {
  UNKNOWN: 'UNKNOWN',
  TRANSCRIPTION: 'transcription',
  VIDEO: 'video',
  BROWSER: 'browser',
  PDF: 'pdf',
  REMOTE_FILES: 'aws_s3',
  WEB_SEARCH: 'web_search',
  EMAIL: 'email',
  TEE: 'tee',
  TASK: 'task',
  WALLET: 'wallet',
  LP_POOL: 'lp_pool',
  TOKEN_DATA: 'token_data',
  TUNNEL: 'tunnel',
} as const;
```

## Best Practices

1. **Type Safety**: Always use proper types instead of `any`
2. **UUID Handling**: Use `asUUID()` helper for validation
3. **Metadata**: Keep metadata structured and documented
4. **Enums**: Use enums for fixed sets of values
5. **Interfaces**: Prefer interfaces over types for objects
6. **Generics**: Use generics for reusable patterns
7. **Type Guards**: Create type guards for runtime checks

# ElizaOS Worlds System

Worlds in ElizaOS are collections of entities (users, agents) and rooms (conversations, channels) that form a cohesive environment for interactions. They act as virtual spaces, similar to Discord servers, Slack workspaces, or 3D MMO environments.

## Core Concepts

### World Structure

```typescript
interface World {
  id: UUID; // Unique identifier
  name?: string; // Display name
  agentId: UUID; // Managing agent ID
  serverId: string; // External system ID
  metadata?: {
    ownership?: {
      ownerId: string; // World owner
    };
    roles?: {
      [entityId: UUID]: Role; // Entity role assignments
    };
    settings?: {
      // World-specific settings
      [key: string]: any;
    };
    [key: string]: unknown; // Additional metadata
  };
}
```

### Role System

```typescript
enum Role {
  OWNER = 'OWNER', // Full control, can assign any roles
  ADMIN = 'ADMIN', // Administrative capabilities
  NONE = 'NONE', // Standard participant
}
```

## World Management

### Creating Worlds

```typescript
// Basic world creation
const worldId = await runtime.createWorld({
  name: 'My Project Space',
  agentId: runtime.agentId,
  serverId: 'external-server-id',
  metadata: {
    ownership: {
      ownerId: ownerEntityId,
    },
  },
});

// Ensure world exists (create if not)
await runtime.ensureWorldExists({
  id: worldId,
  name: 'My Project Space',
  agentId: runtime.agentId,
  serverId: serverId,
});
```

### World Operations

```typescript
// Get world information
const world = await runtime.getWorld(worldId);

// Get all worlds
const allWorlds = await runtime.getAllWorlds();

// Update world properties
await runtime.updateWorld({
  id: worldId,
  name: 'Updated Name',
  metadata: {
    ...world.metadata,
    customProperty: 'value',
  },
});
```

## Role Management

```typescript
// Assign role to entity
const world = await runtime.getWorld(worldId);
if (!world.metadata) world.metadata = {};
if (!world.metadata.roles) world.metadata.roles = {};

world.metadata.roles[entityId] = Role.ADMIN;
await runtime.updateWorld(world);

// Check permissions
import { canModifyRole } from '@elizaos/core';

if (canModifyRole(userRole, targetRole, newRole)) {
  // Allow role change
}

// Find worlds where user is owner
import { findWorldForOwner } from '@elizaos/core';
const userWorld = await findWorldForOwner(runtime, entityId);
```

## World Settings

Worlds support configurable settings:

```typescript
import { getWorldSettings, updateWorldSettings } from '@elizaos/core';

// Get settings
const settings = await getWorldSettings(runtime, serverId);

// Update settings
settings.MY_SETTING = {
  name: 'My Setting',
  description: 'User-facing description',
  value: 'setting-value',
  required: false,
};

await updateWorldSettings(runtime, serverId, settings);
```

## Relationship with Rooms

Worlds contain multiple rooms (channels/conversations):

```typescript
// Get all rooms in a world
const worldRooms = await runtime.getRooms(worldId);

// Rooms reference their parent world
const room = {
  id: roomId,
  worldId: worldId, // Parent world reference
  // ... other properties
};
```

## World Events

```typescript
// World-related events
enum EventType {
  WORLD_JOINED = 'WORLD_JOINED',
  WORLD_CONNECTED = 'WORLD_CONNECTED',
  WORLD_LEFT = 'WORLD_LEFT',
}

// Handle world events in plugin
const plugin: Plugin = {
  name: 'world-handler',
  events: {
    [EventType.WORLD_JOINED]: [
      async (payload: WorldPayload) => {
        const { world, runtime, entities, rooms } = payload;
        console.log(`Joined world: ${world.name}`);

        // Sync entities and rooms
        await runtime.ensureConnections(entities, rooms, source, world);
      },
    ],
  },
};
```

## Integration Patterns

### Discord Server → World

```typescript
// Discord server becomes a world
const world = {
  id: createUniqueUuid(runtime, discord.guild.id),
  name: discord.guild.name,
  serverId: discord.guild.id,
  metadata: {
    platform: 'discord',
    memberCount: discord.guild.memberCount,
  },
};
```

### DM World Creation

For direct messages, create a world with ownership:

```typescript
// DM creates personal world
const dmWorld = {
  id: createUniqueUuid(runtime, userId),
  name: `${userName}'s Space`,
  serverId: userId,
  metadata: {
    ownership: {
      ownerId: userId,
    },
    roles: {
      [userId]: Role.OWNER,
    },
    settings: {}, // For onboarding
  },
};
```

## Best Practices

1. **Permission Checking**: Always verify roles before administrative actions
2. **Metadata Management**: Modify metadata carefully - it contains critical config
3. **World-Room Sync**: Keep world and room structures aligned with external platforms
4. **Event-Driven**: Use events to respond to world changes
5. **Default Settings**: Provide sensible defaults for world settings

## Common Use Cases

- **Multi-tenant Platforms**: Each organization gets its own world
- **Gaming Environments**: Game servers as worlds with zones as rooms
- **Social Platforms**: Discord servers, Slack workspaces
- **Private Spaces**: DM conversations with personal settings
- **Collaborative Tools**: Project spaces with role-based access

# ElizaOS Actions System

Actions define how agents respond to and interact with messages. They are the core components that define an agent's capabilities and enable complex behaviors through action chaining.

## Core Concepts

### Action Structure

```typescript
interface Action {
  name: string; // Unique identifier
  similes: string[]; // Alternative names/triggers
  description: string; // Purpose and usage explanation
  validate: Validator; // Check if action is appropriate
  handler: Handler; // Core implementation logic
  examples: ActionExample[][]; // Sample usage patterns
  suppressInitialMessage?: boolean;
  effects?: {
    provides: string[]; // What this action provides
    requires: string[]; // What this action needs
    modifies: string[]; // What state it changes
  };
  estimateCost?: (params: any) => number; // Optional cost estimation
}
```

### Action Chaining

Actions can be chained together, with each action receiving:

- Results from previous actions (`ActionResult`)
- Access to shared working memory
- Accumulated state from earlier executions

```typescript
interface ActionResult {
  values?: { [key: string]: any }; // Values to merge into state
  data?: { [key: string]: any }; // Internal data for next action
  text?: string; // Summary text
}

interface ActionContext {
  previousResults?: ActionResult[];
  workingMemory?: WorkingMemory;
  updateMemory?: (key: string, value: any) => void;
  getMemory?: (key: string) => any;
  getPreviousResult?: (stepId: UUID) => ActionResult | undefined;
}
```

## Implementation Patterns

### Basic Action

```typescript
const customAction: Action = {
  name: 'CUSTOM_ACTION',
  similes: ['ALTERNATE_NAME'],
  description: 'Action description',

  validate: async (runtime, message, state) => {
    // Return true if action is valid for this message
    return message.content.text?.includes('trigger');
  },

  handler: async (runtime, message, state, options, callback) => {
    // Access action context
    const context = options?.context as ActionContext;

    // Use previous results
    const previousData = context?.previousResults?.[0]?.data;

    // Use working memory
    context?.updateMemory?.('step', 1);

    // Send response
    await callback({
      text: 'Response text',
      thought: 'Internal reasoning',
      actions: ['CUSTOM_ACTION'],
    });

    // Return result for next action
    return {
      values: { processedData: 'value' },
      data: { internal: 'state' },
    };
  },

  examples: [
    [
      { name: '{{user}}', content: { text: 'trigger text' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Response',
          thought: 'Reasoning',
          actions: ['CUSTOM_ACTION'],
        },
      },
    ],
  ],
};
```

### Chained Actions

```typescript
// First action fetches data
const fetchAction: Action = {
  name: 'FETCH_DATA',
  handler: async (runtime, message, state, options, callback) => {
    const data = await fetchExternalData();
    return {
      values: { fetchedData: data },
      data: { source: 'api' },
    };
  },
};

// Second action processes data
const processAction: Action = {
  name: 'PROCESS_DATA',
  handler: async (runtime, message, state, options, callback) => {
    const context = options?.context as ActionContext;
    const data = context?.previousResults?.[0]?.values?.fetchedData;

    const processed = await processData(data);

    await callback({
      text: `Processed ${processed.length} items`,
      thought: 'Data processing complete',
    });

    return { values: { processed } };
  },
};
```

## Agent Decision Flow

1. Message received → Agent evaluates all actions via `validate()`
2. Valid actions provided to LLM via `actionsProvider`
3. LLM decides which action(s) to execute
4. Actions execute in sequence, each receiving previous results
5. Response sent back to conversation

## Integration Points

- **Providers**: Supply context before action selection
- **Evaluators**: Process conversation after actions complete
- **Services**: Enable actions to interact with external systems
- **Working Memory**: Maintains state across action chain

## Best Practices

1. **Validation**: Keep `validate()` functions fast and efficient
2. **Error Handling**: Actions should handle errors gracefully
3. **Return Values**: Always return `ActionResult` for chaining
4. **Working Memory**: Clean up after multi-step processes
5. **Examples**: Provide clear examples for LLM understanding
6. **Effects**: Define provides/requires/modifies for planning

## Common Action Types

- **REPLY**: Basic text response
- **CONTINUE**: Extend conversation
- **IGNORE**: Explicitly do nothing
- **SEND_TOKEN**: Blockchain transactions
- **GENERATE_IMAGE**: Media generation
- **FETCH_DATA**: External API calls
- **PROCESS_DATA**: Data transformation
- **MULTI_STEP**: Complex workflows

KEEP IT SIMPLE!

Always implement real working code, never examples or shortcuts-- those just cause problems in the future.

If you're not sure, ask me about something, I know a lot about the system.

Don't create new files unless you need to. Revise existing files whenever possible. It makes cleanup much easier in the future. Instead of creating a \_v2.ts, just update the v1.

IF you write docs, store them in the /docs folder

If you save logs, store them in the /logs folder

# ElizaOS End-to-End Runtime Testing

This guide explains how to create end-to-end (E2E) runtime tests for ElizaOS projects and plugins using the ElizaOS CLI test runner.

## Overview

ElizaOS E2E tests are **real runtime tests** that:

- Execute against actual ElizaOS runtime instances with live services
- Use real database (in-memory PGLite for testing), plugins, and AI capabilities
- Create real messages, memories, and interactions
- Verify actual agent behaviors and responses
- Are run using the `elizaos test` command which wraps vitest

## Core Interfaces

```typescript
import type { IAgentRuntime } from '@elizaos/core';

/**
 * Represents a test case for evaluating agent or plugin functionality.
 */
export interface TestCase {
  /** A descriptive name for the test case */
  name: string;
  /** The test function that receives the runtime instance */
  fn: (runtime: IAgentRuntime) => Promise<void> | void;
}

/**
 * Represents a suite of related test cases.
 */
export interface TestSuite {
  /** A descriptive name for the test suite */
  name: string;
  /** An array of TestCase objects */
  tests: TestCase[];
}
```

## Test Structure

### 1. Test Suite Class Implementation

```typescript
import { type TestSuite } from '@elizaos/core';

export class MyTestSuite implements TestSuite {
  name = 'my-test-suite';
  description = 'E2E tests for my feature';

  tests = [
    {
      name: 'Test case 1',
      fn: async (runtime: any) => {
        // Test implementation
        // Throw error on failure
      },
    },
    {
      name: 'Test case 2',
      fn: async (runtime: any) => {
        // Another test
      },
    },
  ];
}

// Export default instance for test runner
export default new MyTestSuite();
```

### 2. Test Suite Organization

For projects with multiple test files:

```typescript
// src/__tests__/e2e/index.ts
import projectTestSuite from './project';
import featureTestSuite from './feature';
import integrationTestSuite from './integration';

export const testSuites = [projectTestSuite, featureTestSuite, integrationTestSuite];

export default testSuites;
```

### 3. Plugin Integration

For plugins, add the test suite to the plugin's `tests` property:

```typescript
// In plugin's tests.ts
export { MyPluginTestSuite } from './__tests__/e2e/my-plugin';

// In plugin's index.ts
import { MyPluginTestSuite } from './tests';

export const myPlugin: Plugin = {
  name: 'my-plugin',
  description: 'My plugin description',
  tests: [MyPluginTestSuite], // Add test suite here
  actions: [...],
  providers: [...],
  // ... other plugin properties
};
```

## Writing E2E Tests

### Key Principles

1. **Real Runtime**: Tests receive an actual `IAgentRuntime` instance - no mocks
2. **Real Environment**: Database, services, and plugins are fully initialized
3. **Real Interactions**: Test actual message processing and agent responses
4. **Error = Failure**: Tests pass if no errors are thrown, fail if errors occur
5. **Independent Tests**: Each test should work in isolation

### Basic Test Pattern

```typescript
{
  name: 'My feature test',
  fn: async (runtime: any) => {
    try {
      // 1. Set up test data
      const testData = {
        // Your test setup
      };

      // 2. Execute the feature
      const result = await runtime.someMethod(testData);

      // 3. Verify the results
      if (!result) {
        throw new Error('Expected result but got nothing');
      }

      // Test passes if we reach here without throwing
    } catch (error) {
      // Re-throw with context for debugging
      throw new Error(`My feature test failed: ${(error as Error).message}`);
    }
  },
}
```

## Common Testing Patterns

### 1. Testing Character Configuration

```typescript
{
  name: 'Character configuration test',
  fn: async (runtime: any) => {
    const character = runtime.character;

    // Verify required fields
    if (!character.name) {
      throw new Error('Character name is missing');
    }

    if (!Array.isArray(character.bio)) {
      throw new Error('Character bio should be an array');
    }

    if (!character.system) {
      throw new Error('Character system prompt is missing');
    }
  },
}
```

### 2. Testing Natural Language Processing

```typescript
{
  name: 'Agent responds to hello world',
  fn: async (runtime: any) => {
    // Create unique identifiers
    const roomId = `test-room-${Date.now()}`;
    const userId = 'test-user';

    // Create message
    const message = {
      id: `msg-${Date.now()}`,
      userId: userId,
      agentId: runtime.agentId,
      roomId: roomId,
      content: {
        text: 'hello world',
        type: 'text',
      },
      createdAt: Date.now(),
    };

    // Process message
    await runtime.processMessage(message);

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Retrieve messages
    const messages = await runtime.messageManager.getMessages({
      roomId,
      limit: 10,
    });

    // Verify response
    const agentResponse = messages.find(
      m => m.userId === runtime.agentId && m.id !== message.id
    );

    if (!agentResponse) {
      throw new Error('Agent did not respond');
    }

    console.log('Agent response:', agentResponse.content.text);
  },
}
```

### 3. Testing Actions

```typescript
{
  name: 'Action execution test',
  fn: async (runtime: any) => {
    // Find action
    const action = runtime.actions.find(a => a.name === 'MY_ACTION');
    if (!action) {
      throw new Error('MY_ACTION not found');
    }

    // Create test message
    const message = {
      entityId: uuidv4(),
      roomId: uuidv4(),
      content: {
        text: 'Test message',
        source: 'test',
        actions: ['MY_ACTION'], // Explicitly request action
      },
    };

    // Create state
    const state = {
      values: {},
      data: {},
      text: '',
    };

    // Set up callback
    let responseReceived = false;
    const callback = async (content) => {
      if (content.actions?.includes('MY_ACTION')) {
        responseReceived = true;
      }
      return [];
    };

    // Execute action
    await action.handler(runtime, message, state, {}, callback, []);

    if (!responseReceived) {
      throw new Error('Action did not execute properly');
    }
  },
}
```

### 4. Testing Providers

```typescript
{
  name: 'Provider functionality test',
  fn: async (runtime: any) => {
    const provider = runtime.providers.find(
      p => p.name === 'MY_PROVIDER'
    );

    if (!provider) {
      throw new Error('MY_PROVIDER not found');
    }

    const result = await provider.get(runtime, message, state);

    if (!result.text) {
      throw new Error('Provider returned no text');
    }
  },
}
```

### 5. Testing Services

```typescript
{
  name: 'Service lifecycle test',
  fn: async (runtime: any) => {
    const service = runtime.getService('my-service');

    if (!service) {
      throw new Error('Service not found');
    }

    // Test service methods
    const result = await service.someMethod();

    if (!result) {
      throw new Error('Service method failed');
    }

    // Test cleanup
    await service.stop();
  },
}
```

### 6. Testing Conversation Context

```typescript
{
  name: 'Agent maintains conversation context',
  fn: async (runtime: any) => {
    const roomId = `test-room-${Date.now()}`;
    const userId = 'test-user';

    // First message
    await runtime.processMessage({
      id: `msg-1`,
      userId,
      roomId,
      content: { text: 'My favorite color is blue.' },
      createdAt: Date.now(),
    });

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Follow-up message
    await runtime.processMessage({
      id: `msg-2`,
      userId,
      roomId,
      content: { text: 'What color did I just mention?' },
      createdAt: Date.now() + 1000,
    });

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Check responses
    const messages = await runtime.messageManager.getMessages({ roomId });
    const responses = messages.filter(m => m.userId === runtime.agentId);

    if (responses.length < 2) {
      throw new Error('Agent did not respond to both messages');
    }

    // Verify context awareness
    const lastResponse = responses[responses.length - 1];
    if (!lastResponse.content.text.toLowerCase().includes('blue')) {
      throw new Error('Agent did not maintain context');
    }
  },
}
```

## File Organization

### For Projects

```
src/
├── __tests__/
│   └── e2e/
│       ├── index.ts           # Test suite exports
│       ├── project.ts         # Project-specific tests
│       ├── natural-language.ts # NLP tests
│       └── integration.ts     # Integration tests
├── index.ts                   # Project entry point
└── character.json             # Character configuration
```

### For Plugins

```
src/
├── __tests__/
│   └── e2e/
│       └── plugin-tests.ts    # Plugin test suite
├── tests.ts                   # Test exports
├── index.ts                   # Plugin definition
├── actions/                   # Action implementations
└── providers/                 # Provider implementations
```

## Running Tests

### Commands

```bash
# Run all tests (from project or plugin directory)
elizaos test

# Or using npm script
npm test

# For coverage (if configured)
npm run test:coverage
```

### Test Output Best Practices

Use console.log for test progress:

```typescript
console.log('Starting my feature test...');
console.log('✓ Step 1 completed');
console.log('✓ Step 2 completed');
console.log('✅ My feature test PASSED');

// On failure
console.error('❌ My feature test FAILED:', error);
```

## Best Practices

1. **Descriptive Names**: Use clear test names that describe what is being tested
2. **Error Context**: Always wrap errors with additional context
3. **Console Logging**: Log progress for easier debugging
4. **Async Handling**: Use appropriate delays for async operations
5. **Unique IDs**: Use timestamps or UUIDs to avoid conflicts
6. **Test Independence**: Don't rely on state from other tests
7. **Real Verifications**: Check actual runtime behavior, not mocked responses

## Common Issues and Solutions

### Runtime Methods Undefined

- Ensure you're using the actual runtime instance provided
- Check that required plugins are loaded in character config
- Verify services are initialized

### Timing Issues

```typescript
// Add delays after async operations
await new Promise((resolve) => setTimeout(resolve, 1000));
```

### Message Processing

- Use unique room IDs to isolate conversations
- Wait for message processing to complete
- Query messages with appropriate filters

### Type Safety

- The runtime parameter is typed as `any` in examples for flexibility
- Cast to specific types when needed for better IDE support

## Advanced Patterns

### Testing Multiple Interactions

```typescript
for (const greeting of ['hello', 'hi', 'hey']) {
  const roomId = `test-${Date.now()}-${Math.random()}`;

  await runtime.processMessage({
    roomId,
    content: { text: greeting },
    // ... other fields
  });

  // Verify each response
}
```

### Parallel Test Execution

```typescript
const promises = messages.map(async (msg) => {
  return runtime.processMessage(msg);
});

await Promise.all(promises);
```

Remember: **No mocks, real runtime, throw errors to fail.**

# ElizaOS Standard Development Workflow

This document outlines the comprehensive process for building, testing, and contributing to the ElizaOS project. Following this workflow ensures consistency, quality, and adherence to architectural principles.

## Step 1: Research Existing Codebase

Before proposing any changes, thoroughly understand the current system.

- **Codebase Analysis**:

  - Use `grep`, `codebase_search`, and file exploration to understand existing patterns
  - Map out all dependencies and related files
  - Identify existing services, actions, providers, and plugins
  - Study similar implementations already in the codebase
  - Document the current architecture and data flow

- **Pattern Recognition**:
  - How are similar features implemented?
  - What conventions does the project follow?
  - What are the established testing patterns?
  - Which utilities and helpers already exist?

## Step 2: Write Detailed PRD (Product Requirements Document)

Create a comprehensive PRD that goes beyond basic requirements.

### PRD Components:

- **Real-World Scenarios**:

  - Document ALL actual usage paths users will take
  - Include edge cases and error scenarios
  - Provide concrete examples with real data
  - Consider different user personas and their needs

- **UX Review**:

  - How can we make the experience more automated?
  - How can we make it more agentic (self-directed)?
  - How can we make it more passive (requiring less user intervention)?
  - What friction points exist in the current workflow?
  - How can we exceed user expectations?

- **Technical Requirements**:

  - Performance requirements
  - Security considerations
  - Scalability needs
  - Integration points with existing systems

- **Success Criteria**:
  - Measurable outcomes
  - User satisfaction metrics
  - Technical performance benchmarks

## Step 3: Create Detailed Implementation Plan

Design multiple approaches and select the optimal solution.

### Implementation Planning Process:

1. **Design 3+ Different Approaches**:

   - Document each approach comprehensively
   - List ALL files that will be:
     - Added (with complete file paths)
     - Modified (with specific changes)
     - Removed (with justification)
   - Detail what content changes in each file

2. **Evaluate Each Approach**:

   - **Strengths**: What makes this approach good?
   - **Weaknesses**: What are the limitations?
   - **Risks**: What could go wrong?
   - **Complexity**: How difficult to implement and maintain?
   - **Performance**: How will it perform at scale?
   - **User Experience**: How does it affect the end user?

3. **Select Optimal Solution**:
   - Choose the BEST solution, not the average one
   - Document why this approach is superior
   - Accept calculated risks for better outcomes
   - Prioritize long-term maintainability

### Implementation Plan Template:

```markdown
## Approach 1: [Name]

### Files to Add:

- `path/to/new/file.ts` - [Purpose and contents]

### Files to Modify:

- `path/to/existing/file.ts`:
  - Add: [Specific additions]
  - Change: [Specific modifications]
  - Remove: [Specific deletions]

### Files to Remove:

- `path/to/deprecated/file.ts` - [Reason for removal]

### Strengths:

- [List strengths]

### Weaknesses:

- [List weaknesses]

### Risks:

- [List risks and mitigation strategies]
```

## Step 4: Implementation - Production Code Only

Write complete, production-ready code with comprehensive testing.

### Critical Implementation Rules:

- **NO Fake Code**: Never write stubs, examples, or placeholder implementations
- **NO POCs**: Never deliver proof-of-concepts - only finished code
- **NO Demos**: Always write production-ready implementations
- **Complete Implementation**: Write out ALL code, even if complex or lengthy

### Testing Requirements:

- **Unit Tests**: Test individual functions and components in isolation
- **E2E Tests**: Test complete workflows with real runtime
- **Frontend Tests**: Test UI components and user interactions where applicable
- **Integration Tests**: Test interactions between components

### Code Quality Standards:

```typescript
// ✅ DO: Write complete implementations
export async function processTransaction(
  runtime: IAgentRuntime,
  params: TransactionParams
): Promise<TransactionResult> {
  // Full validation logic
  if (!params.amount || params.amount <= 0) {
    throw new Error('Invalid transaction amount');
  }

  // Complete implementation with error handling
  try {
    const service = runtime.getService('transaction-service');
    const result = await service.process(params);

    // Full logging and monitoring
    runtime.logger.info('Transaction processed', {
      transactionId: result.id,
      amount: params.amount,
    });

    return result;
  } catch (error) {
    runtime.logger.error('Transaction failed', { error, params });
    throw new TransactionError('Failed to process transaction', error);
  }
}

// ❌ DON'T: Write stubs or incomplete code
export async function processTransaction(params: any): Promise<any> {
  // TODO: Implement this
  throw new Error('Not implemented');
}
```

## Step 5: Fix Tests Until All Pass

Run comprehensive testing with real-world conditions.

### Testing Philosophy:

- **Real Runtime**: Use live agent runtime, not mocks
- **Real Environment**: Test on mainnet with live API keys
- **Real Data**: Use actual data, not synthetic test data
- **Real Scenarios**: Test actual user workflows

### Testing Process:

1. **Run All Test Suites**:

   ```bash
   # Unit tests
   bun test

   # E2E tests with real runtime
   elizaos test

   # Frontend tests
   bun run test:frontend
   ```

2. **Focus on Meaningful Tests**:

   - ✅ Test that services register correctly
   - ✅ Test that actions execute with real data
   - ✅ Test error handling and edge cases
   - ❌ Don't test trivial getters/setters
   - ❌ Don't test framework functionality

3. **Iterate Until Perfect**:
   - Fix failing tests
   - Add missing test cases
   - Verify edge cases
   - Ensure consistent results

## Step 6: Critical Review and Iteration

Assume the implementation has issues and actively find them.

### Review Process:

1. **Assume It's Wrong**:

   - What assumptions did we make that could be incorrect?
   - What edge cases did we miss?
   - What could break in production?
   - How could users misuse this feature?

2. **Document All Issues**:

   - List every potential problem
   - Identify performance bottlenecks
   - Find security vulnerabilities
   - Note UX friction points

3. **Create Improvement Plan**:

   - Prioritize issues by severity
   - Design solutions for each problem
   - Update implementation plan
   - Revise PRD if necessary

4. **Validation Checklist**:
   - [ ] Does it meet all PRD requirements?
   - [ ] Are all tests comprehensive and passing?
   - [ ] Is the code maintainable?
   - [ ] Is the UX optimal?
   - [ ] Are there any security concerns?
   - [ ] Will it scale appropriately?

## Iteration Loop

After the critical review, loop through these steps until the code is production-ready:

1. **Design New Implementation Plan**: Address all identified issues
2. **Implement All Code and Tests**: Complete production code only
3. **Fix Everything Until Tests Pass**: Real-world testing
4. **Write Another Review**: Assert code correctness or need for revision

### When to Stop Iterating:

- All tests pass consistently (no tests skipped!)
- All features have significant test coverage
- Everything is cleaned up, no dead or useless files, no unnecessary tests
- Code meets or exceeds PRD requirements
- No critical issues in review
- Performance meets benchmarks
- Security review passes
- UX is optimized

### Common Pitfalls:

- **Premature Completion**: Models often think they're done when they aren't
- **Insufficient Testing**: Always err on the side of more testing
- **Ignoring Edge Cases**: Every edge case matters in production
- **Accepting "Good Enough"**: Always strive for optimal, not average

## Core Plugin Architecture

The ElizaOS plugin system is the primary mechanism for extending agent capabilities. A plugin is a self-contained module that can register various components with the `AgentRuntime`. The runtime acts as the central nervous system, managing the lifecycle and interactions of these components.

## The `Plugin` Interface: The Heart of a Plugin

Every plugin is an object that conforms to the `Plugin` interface. This interface is a manifest of all the capabilities the plugin provides to the runtime.

```typescript
// packages/core/src/types.ts (Annotated)
export interface Plugin {
  // Required: A unique NPM-style package name. (e.g., '@elizaos/plugin-sql')
  name: string;
  // Required: A human-readable description of the plugin's purpose.
  description: string;

  // An initialization function called once when the plugin is registered.
  // Use this for setup, validation, and connecting to services.
  init?: (config: Record<string, string>, runtime: IAgentRuntime) => Promise<void>;

  // A list of other plugin *names* that must be loaded before this one.
  dependencies?: string[];

  // A priority number for ordering. Higher numbers load first within the dependency graph.
  priority?: number;

  // --- Core Capabilities ---

  // Services are long-running, stateful classes. (e.g., a database connection manager)
  services?: (typeof Service)[];

  // Actions define what an agent *can do*. They are the agent's tools.
  actions?: Action[];

  // Providers supply contextual information into the agent's "state" before a decision is made.
  providers?: Provider[];

  // Evaluators run *after* an interaction to process the outcome (e.g., for memory or learning).
  evaluators?: Evaluator[];

  // Model handlers provide implementations for different AI model types (e.g., text generation).
  models?: { [key: string]: (...args: any[]) => Promise<any> };

  // --- Advanced Capabilities ---

  // A database adapter. Typically only one SQL plugin provides this for the entire runtime.
  adapter?: IDatabaseAdapter;

  // Event handlers to listen for and react to specific runtime events.
  events?: PluginEvents;

  // Custom HTTP routes to expose a web API or UI from the agent server.
  routes?: Route[];

  // A suite of E2E or unit tests, runnable via `elizaos test`.
  tests?: TestSuite[];

  // Default configuration values for the plugin.
  config?: { [key: string]: any };
}
```

## Plugin Lifecycle and Dependency Resolution

The `AgentRuntime` manages a sophisticated plugin lifecycle to ensure stability and correct ordering.

1.  **Dependency Resolution**: When `runtime.initialize()` is called, it first looks at the `plugins` array in the agent's `Character` definition. It then recursively scans the `dependencies` array of each of these plugins, building a complete graph of all required plugins.
2.  **Topological Sort**: The runtime performs a topological sort on the dependency graph. This creates a linear loading order where every plugin is guaranteed to be loaded _after_ its dependencies have been loaded. `priority` is used as a secondary sorting factor.
3.  **Registration**: The runtime iterates through the sorted list and calls `runtime.registerPlugin()` for each plugin.
4.  **Initialization (`init`)**: The `init` function of the plugin is the first thing called within `registerPlugin`. This is the critical "setup" phase. It is the only place you can be certain that all dependency plugins (and their services) are available.
5.  **Component Registration**: After `init` completes successfully, the runtime registers all other capabilities (`actions`, `providers`, etc.) from the plugin object, making them available to the rest of the system.

```typescript
// packages/core/src/runtime.ts

export class AgentRuntime implements IAgentRuntime {
  // ...
  async initialize(): Promise<void> {
    // 1. & 2. Resolve dependencies and get the final, sorted list of plugins to load
    const pluginsToLoad = await this.resolvePluginDependencies(this.characterPlugins);

    // 3. Iterate over the resolved list and register each plugin
    for (const plugin of pluginsToLoad) {
      // 4. & 5. Call registerPlugin, which handles init and component registration
      await this.registerPlugin(plugin);
    }
    // ...
  }

  async registerPlugin(plugin: Plugin): Promise<void> {
    // ...
    // Call the plugin's init function FIRST
    if (plugin.init) {
      await plugin.init(plugin.config || {}, this);
    }

    // Then, register all other components
    if (plugin.services) {
      for (const service of plugin.services) {
        await this.registerService(service);
      }
    }
    if (plugin.actions) {
      for (const action of plugin.actions) {
        this.registerAction(action);
      }
    }
    // ... and so on for providers, evaluators, models, routes, etc.
  }
}
```

## Deep Dive: Plugin Components

### Services

Services are singleton classes that manage long-running processes or state. They are the backbone for complex plugins.

- **Definition**: A `Service` is a class with a static `start` method.
- **Lifecycle**: `Service.start(runtime)` is called during plugin registration. The returned instance is stored in `runtime.services`.
- **Access**: Other components access services via `runtime.getService<T>('service_name')`.
- **Use Case**: A `ConnectionService` for a blockchain, a `WebSocketClient` for a chat platform, a `CacheManager`.

```typescript
// ✅ DO: Define a service for stateful logic.
export class MyCacheService extends Service {
  public static serviceType = 'my_cache'; // Unique identifier
  private cache = new Map<string, any>();

  // The start method is the factory for the service instance
  static async start(runtime: IAgentRuntime): Promise<MyCacheService> {
    const instance = new MyCacheService(runtime);
    runtime.logger.info('MyCacheService started.');
    return instance;
  }

  public get(key: string) {
    return this.cache.get(key);
  }
  public set(key: string, value: any) {
    this.cache.set(key, value);
  }

  async stop(): Promise<void> {
    this.cache.clear();
  }
  public get capabilityDescription(): string {
    return 'An in-memory cache.';
  }
}
```

### Actions

Actions define what an agent _can do_. They are the primary way to give an agent capabilities.

- **Definition**: An `Action` object contains a `name`, `description`, `validate` function, and `handler` function.
- **Lifecycle**: After the LLM selects an action, its `handler` is executed.
- **Use Case**: `send-email`, `transfer-funds`, `query-database`.

```typescript
// ✅ DO: Define a clear, purposeful action.
export const sendTweetAction: Action = {
  name: 'send-tweet',
  description: 'Posts a tweet to the connected Twitter account.',
  // The handler function contains the core logic.
  async handler(runtime, message, state) {
    const twitterService = runtime.getService<TwitterService>('twitter');
    if (!twitterService) throw new Error('Twitter service not available.');

    const textToTweet = message.content.text;
    const tweetId = await twitterService.postTweet(textToTweet);
    return { text: `Tweet posted successfully! ID: ${tweetId}` };
  },
  // The validate function determines if the action should be available to the LLM.
  async validate(runtime, message, state) {
    const twitterService = runtime.getService('twitter');
    return !!twitterService; // Only available if the twitter service is running.
  },
};
```

### Providers

Providers inject contextual information into the agent's "state" before the LLM makes a decision. They are the agent's senses.

- **Definition**: A `Provider` object has a `name` and a `get` function.
- **Lifecycle**: The `get` function of all registered (non-private) providers is called by `runtime.composeState()` before invoking the main LLM.
- **Use Case**: `CURRENT_TIME`, `RECENT_MESSAGES`, `ACCOUNT_BALANCE`, `WORLD_STATE`.

```typescript
// ✅ DO: Create providers for dynamic context.
export const accountBalanceProvider: Provider = {
  name: 'ACCOUNT_BALANCE',
  // The 'get' function returns text and structured data to be injected into the prompt.
  async get(runtime, message, state) {
    const solanaService = runtime.getService<SolanaService>('solana');
    if (!solanaService) return { text: '' };

    const balance = await solanaService.getBalance();
    const text = `The current wallet balance is ${balance} SOL.`;

    return {
      text: `[ACCOUNT BALANCE]\n${text}\n[/ACCOUNT BALANCE]`,
      values: {
        // This data can be used by other components
        solBalance: balance,
      },
    };
  },
};
```

## Best Practices

- **Explicit Dependencies**: Always declare `dependencies` to ensure correct load order. The runtime does not guarantee service availability otherwise.
- **Fail Fast**: In your `init` function, check for required configuration (e.g., API keys via `runtime.getSetting()`) and throw an error if something critical is missing. This prevents the agent from running in a broken state.
- **Scoped Logic**: Keep your plugin focused. A single plugin should manage one core piece of functionality (e.g., one API integration, one protocol).
- **Use Services for State**: Avoid global variables. If you need to maintain state (like a connection object, cache, or user session), encapsulate it within a `Service`.

## References

- [Core Types (`Plugin`, `Action`, `Provider` etc.)](packages/core/src/types.ts)
- [Agent Runtime Implementation](packages/core/src/runtime.ts)
- [Example: SQL Plugin](packages/plugin-sql/src/index.ts)
- [Example: Bootstrap Plugin](packages/plugin-message-handling/src/index.ts)

# ElizaOS Rooms System

Rooms represent individual interaction spaces within worlds. They can be conversations, channels, threads, or any defined space where entities exchange messages and interact.

## Core Concepts

### Room Structure

```typescript
interface Room {
  id: UUID; // Unique identifier
  name?: string; // Display name
  agentId?: UUID; // Associated agent ID
  source: string; // Platform origin (discord, telegram, etc)
  type: ChannelType; // Type of room
  channelId?: string; // External channel ID
  serverId?: string; // External server ID
  worldId?: UUID; // Parent world ID
  metadata?: Record<string, unknown>;
}
```

### Channel Types

```typescript
enum ChannelType {
  SELF = 'SELF', // Messages to self
  DM = 'DM', // Direct messages
  GROUP = 'GROUP', // Group messages
  VOICE_DM = 'VOICE_DM', // Voice direct messages
  VOICE_GROUP = 'VOICE_GROUP', // Voice channels
  FEED = 'FEED', // Social media feed
  THREAD = 'THREAD', // Threaded conversation
  WORLD = 'WORLD', // World channel
  FORUM = 'FORUM', // Forum discussion
  API = 'API', // Legacy - use DM or GROUP
}
```

## Room Management

### Creating Rooms

```typescript
// Create new room
const roomId = await runtime.createRoom({
  name: 'general-chat',
  source: 'discord',
  type: ChannelType.GROUP,
  channelId: 'external-channel-id',
  serverId: 'external-server-id',
  worldId: parentWorldId,
});

// Ensure room exists
await runtime.ensureRoomExists({
  id: roomId,
  name: 'general-chat',
  source: 'discord',
  type: ChannelType.GROUP,
  channelId: 'external-channel-id',
  serverId: 'external-server-id',
  worldId: parentWorldId,
});
```

### Room Operations

```typescript
// Get room information
const room = await runtime.getRoom(roomId);

// Get all rooms in a world
const worldRooms = await runtime.getRooms(worldId);

// Update room properties
await runtime.updateRoom({
  id: roomId,
  name: 'renamed-channel',
  metadata: {
    ...room.metadata,
    customProperty: 'value',
  },
});

// Delete room
await runtime.deleteRoom(roomId);
```

## Participants

Rooms have participants (entities) that can exchange messages:

### Managing Participants

```typescript
// Add participant
await runtime.addParticipant(entityId, roomId);

// Remove participant
await runtime.removeParticipant(entityId, roomId);

// Get room participants
const participants = await runtime.getParticipantsForRoom(roomId);

// Get rooms for entity
const entityRooms = await runtime.getRoomsForParticipant(entityId);
```

### Participant States

```typescript
// Participant states
type ParticipantState = 'FOLLOWED' | 'MUTED' | null;

// Get participant state
const state = await runtime.getParticipantUserState(roomId, entityId);

// Set participant state
await runtime.setParticipantUserState(roomId, entityId, 'FOLLOWED');
```

| State      | Description                                         |
| ---------- | --------------------------------------------------- |
| `FOLLOWED` | Agent actively follows and responds without mention |
| `MUTED`    | Agent ignores messages in this room                 |
| `null`     | Default - responds only when mentioned              |

## Messages and Memory

Rooms store messages as memories:

```typescript
// Create message
const messageId = await runtime.createMemory(
  {
    entityId: senderEntityId,
    agentId: runtime.agentId,
    roomId: roomId,
    content: {
      text: 'Hello, world!',
      source: 'discord',
    },
    metadata: {
      type: 'message',
    },
  },
  'messages'
);

// Retrieve recent messages
const messages = await runtime.getMemories({
  roomId: roomId,
  count: 10,
  unique: true,
});
```

## Room Events

```typescript
// Room-related events
enum EventType {
  ROOM_JOINED = 'ROOM_JOINED',
  ROOM_LEFT = 'ROOM_LEFT',
  MESSAGE_RECEIVED = 'MESSAGE_RECEIVED',
  MESSAGE_SENT = 'MESSAGE_SENT',
}

// Handle room events
const plugin: Plugin = {
  name: 'room-handler',
  events: {
    [EventType.ROOM_JOINED]: [
      async (payload) => {
        const { runtime, entityId, roomId } = payload;
        console.log(`Entity ${entityId} joined room ${roomId}`);
      },
    ],

    [EventType.MESSAGE_RECEIVED]: [
      async (payload: MessagePayload) => {
        const { runtime, message } = payload;
        console.log(`Message in room ${message.roomId}`);
      },
    ],
  },
};
```

## Follow/Unfollow Actions

Agents can follow rooms to actively participate:

```typescript
// Follow room action
const followRoomAction: Action = {
  name: 'FOLLOW_ROOM',
  handler: async (runtime, message) => {
    await runtime.setParticipantUserState(message.roomId, runtime.agentId, 'FOLLOWED');
  },
};

// Unfollow room action
const unfollowRoomAction: Action = {
  name: 'UNFOLLOW_ROOM',
  handler: async (runtime, message) => {
    await runtime.setParticipantUserState(message.roomId, runtime.agentId, null);
  },
};
```

## External System Integration

Rooms map to external platform structures:

```typescript
// Ensure connection exists
await runtime.ensureConnection({
  entityId: userEntityId,
  roomId: roomId,
  userName: 'username',
  name: 'display-name',
  source: 'discord',
  channelId: 'external-channel-id',
  serverId: 'external-server-id',
  type: ChannelType.GROUP,
  worldId: parentWorldId,
});
```

## Best Practices

1. **Use Appropriate Types**: Select correct room type for interaction context
2. **World Relationship**: Create worlds before rooms
3. **Use ensureRoomExists**: Avoid duplicates when syncing
4. **Clean Up**: Delete rooms when no longer needed
5. **Metadata Usage**: Use for room-specific configuration
6. **Follow State**: Implement clear rules for follow/unfollow
7. **Participant Sync**: Align with external platform behavior

## Common Patterns

### Direct Message Room

```typescript
const dmRoom = {
  id: createUniqueUuid(runtime, `${user1}-${user2}`),
  name: 'Direct Message',
  source: 'discord',
  type: ChannelType.DM,
  worldId: userWorldId,
};
```

### Voice Channel Room

```typescript
const voiceRoom = {
  id: createUniqueUuid(runtime, voiceChannelId),
  name: 'Voice Chat',
  source: 'discord',
  type: ChannelType.VOICE_GROUP,
  worldId: serverWorldId,
  metadata: {
    bitrate: 64000,
    userLimit: 10,
  },
};
```

### Social Feed Room

````typescript
const feedRoom = {
  id: createUniqueUuid(runtime, `${userId}-feed`),
  name: `${userName}'s Feed`,
  source: 'twitter',
  type: ChannelType.FEED,
  worldId: userWorldId,
};

# ElizaOS API Server

The ElizaOS API Server provides HTTP REST endpoints, WebSocket communication, and core services for managing agents, messages, media, and system operations.

## Server Architecture

### Core Components

```typescript
class AgentServer {
  app: express.Application; // Express app instance
  agents: Map<UUID, IAgentRuntime>; // Active agent runtimes
  server: http.Server; // HTTP server
  socketIO: SocketIOServer; // Socket.IO server
  database: DatabaseAdapter; // Database connection
}
````

### Initialization Flow

1. **Database Setup**: Initialize SQL database with migrations
2. **Default Server**: Ensure default message server exists
3. **Middleware**: Security headers, CORS, body parsing
4. **Routes**: Mount API routers
5. **Socket.IO**: Setup real-time communication
6. **Static Files**: Serve client application

## API Structure

All API endpoints are mounted under `/api` with the following structure:

```
/api
├── /agents      # Agent management
├── /audio       # Audio processing
├── /media       # File uploads
├── /memory      # Memory operations
├── /messaging   # Message handling
├── /runtime     # Server operations
├── /system      # Configuration
└── /tee         # Trusted execution (future)
```

## Authentication

Optional API key authentication via `X-API-KEY` header:

```typescript
// Set via environment variable
process.env.ELIZA_SERVER_AUTH_TOKEN = "your-secret-key"

// Client request
headers: {
  'X-API-KEY': 'your-secret-key'
}
```

## Agent Management (`/api/agents`)

### CRUD Operations

```typescript
// List all agents
GET /api/agents
Response: {
  success: true,
  data: {
    agents: [{
      id: UUID,
      name: string,
      characterName: string,
      bio: string,
      status: 'active' | 'inactive'
    }]
  }
}

// Get specific agent
GET /api/agents/:agentId
Response: { ...agent, status: string }

// Create new agent
POST /api/agents
Body: {
  characterPath?: string,  // File path
  characterJson?: object   // Direct JSON
}
Response: {
  success: true,
  data: { id: UUID, character: Character }
}

// Update agent
PATCH /api/agents/:agentId
Body: { ...updates }

// Delete agent
DELETE /api/agents/:agentId
Response: 204 No Content
```

### Lifecycle Management

```typescript
// Start agent
POST /api/agents/:agentId/start
Response: { id, name, status: 'active' }

// Stop agent
POST /api/agents/:agentId/stop
Response: { message: 'Agent stopped' }
```

### Agent Logs

```typescript
// Get agent logs
GET /api/agents/:agentId/logs
Query: {
  roomId?: UUID,
  type?: string,
  count?: number,
  offset?: number,
  excludeTypes?: string[]
}

// Delete specific log
DELETE /api/agents/:agentId/logs/:logId
```

### Agent Panels (Plugin Routes)

```typescript
// Get public plugin routes
GET /api/agents/:agentId/panels
Response: [{
  name: string,
  path: string
}]
```

### Agent Worlds

```typescript
// Get all worlds
GET /api/agents/worlds

// Create world for agent
POST /api/agents/:agentId/worlds
Body: { name, serverId?, metadata? }

// Update world
PATCH /api/agents/:agentId/worlds/:worldId
Body: { name?, metadata? }
```

### Agent Memory

```typescript
// Get memories for room
GET /api/agents/:agentId/rooms/:roomId/memories
Query: {
  limit?: number,
  before?: timestamp,
  includeEmbedding?: boolean,
  tableName?: string
}

// Get all agent memories
GET /api/agents/:agentId/memories
Query: {
  channelId?: UUID,
  roomId?: UUID,
  tableName?: string
}

// Update memory
PATCH /api/agents/:agentId/memories/:memoryId

// Delete all memories for room
DELETE /api/agents/:agentId/memories/all/:roomId
```

## Audio Processing (`/api/audio`)

### Transcription

```typescript
// Transcribe audio file
POST /api/audio/:agentId/transcriptions
Content-Type: multipart/form-data
Body: { file: AudioFile }
Response: { text: string }

// Process audio message
POST /api/audio/:agentId/audio-messages
Content-Type: multipart/form-data
Body: { file: AudioFile }
```

### Speech Synthesis

```typescript
// Text to speech
POST /api/audio/:agentId/audio-messages/synthesize
Body: { text: string }
Response: Audio buffer (audio/mpeg or audio/wav)

// Generate speech
POST /api/audio/:agentId/speech/generate
Body: { text: string }
Response: Audio buffer
```

### Speech Conversation

```typescript
// Interactive conversation
POST /api/audio/:agentId/speech/conversation
Body: {
  text: string,
  roomId?: UUID,
  entityId?: UUID,
  worldId?: UUID,
  userName?: string,
  attachments?: any[]
}
Response: Audio buffer of agent response
```

## Media Management (`/api/media`)

### Agent Media Upload

```typescript
// Upload media for agent
POST /api/media/agents/:agentId/upload-media
Content-Type: multipart/form-data
Body: { file: MediaFile }
Response: {
  url: string,      // /media/uploads/agents/:agentId/:filename
  type: string,     // MIME type
  filename: string,
  originalName: string,
  size: number
}
```

### Channel Media Upload

```typescript
// Upload media for channel
POST /api/media/channels/:channelId/upload-media
Content-Type: multipart/form-data
Body: { file: MediaFile }
Response: {
  url: string,      // /media/uploads/channels/:channelId/:filename
  type: string,
  filename: string,
  originalName: string,
  size: number
}
```

### Media Constraints

- **Max file size**: 50MB
- **Audio types**: mp3, wav, ogg, webm, mp4, aac, flac
- **Media types**: Audio + jpeg, png, gif, webp, mp4, webm, pdf, txt

## Memory Operations (`/api/memory`)

### Room Management

```typescript
// Create room for agent
POST /api/memory/:agentId/rooms
Body: {
  name: string,
  type?: ChannelType,
  source?: string,
  worldId?: UUID,
  metadata?: object
}

// Get agent's rooms
GET /api/memory/:agentId/rooms

// Get room details
GET /api/memory/:agentId/rooms/:roomId
```

### Group Memory

```typescript
// Create group memory space
POST /api/memory/groups/:serverId
Body: {
  name?: string,
  worldId?: UUID,
  source?: string,
  metadata?: object,
  agentIds: UUID[]
}

// Delete group
DELETE /api/memory/groups/:serverId

// Clear group memories
DELETE /api/memory/groups/:serverId/memories
```

## Messaging System (`/api/messaging`)

### Core Messaging

```typescript
// Submit agent response
POST /api/messaging/submit
Body: {
  channel_id: UUID,
  server_id: UUID,
  author_id: UUID,
  content: string,
  in_reply_to_message_id?: UUID,
  source_type: string,
  raw_message: object,
  metadata?: object
}

// Notify message complete
POST /api/messaging/complete
Body: { channel_id: UUID, server_id: UUID }

// Ingest external message
POST /api/messaging/ingest-external
Body: MessageServiceStructure
```

### Server Management

```typescript
// List servers
GET /api/messaging/central-servers

// Create server
POST /api/messaging/servers
Body: { name, sourceType, sourceId?, metadata? }

// Manage server agents
POST /api/messaging/servers/:serverId/agents
Body: { agentId: UUID }

DELETE /api/messaging/servers/:serverId/agents/:agentId

GET /api/messaging/servers/:serverId/agents

GET /api/messaging/agents/:agentId/servers
```

### Channel Management

```typescript
// Post message to channel
POST /api/messaging/central-channels/:channelId/messages
Body: {
  author_id: UUID,
  content: string,
  server_id: UUID,
  metadata?: object,
  attachments?: any[]
}

// Get channel messages
GET /api/messaging/central-channels/:channelId/messages
Query: { limit?: number, before?: timestamp }

// Create channel
POST /api/messaging/central-channels
Body: {
  name: string,
  server_id: UUID,
  type?: ChannelType,
  participantCentralUserIds: UUID[]
}

// Get/Create DM channel
GET /api/messaging/dm-channel
Query: {
  targetUserId: UUID,
  currentUserId: UUID,
  dmServerId?: UUID
}

// Channel operations
GET /api/messaging/central-channels/:channelId/details
GET /api/messaging/central-channels/:channelId/participants
PATCH /api/messaging/central-channels/:channelId
DELETE /api/messaging/central-channels/:channelId

// Channel agents
POST /api/messaging/central-channels/:channelId/agents
DELETE /api/messaging/central-channels/:channelId/agents/:agentId
GET /api/messaging/central-channels/:channelId/agents

// Message operations
DELETE /api/messaging/central-channels/:channelId/messages/:messageId
DELETE /api/messaging/central-channels/:channelId/messages
```

## Runtime Management (`/api/runtime`)

### Health Monitoring

```typescript
// Basic ping
GET /api/runtime/ping
Response: { pong: true, timestamp: number }

// Hello world
GET /api/runtime/hello
Response: { message: 'Hello World!' }

// System status
GET /api/runtime/status
Response: {
  status: 'ok',
  agentCount: number,
  timestamp: string
}

// Comprehensive health
GET /api/runtime/health
Response: {
  status: 'OK',
  version: string,
  timestamp: string,
  dependencies: {
    agents: 'healthy' | 'no_agents'
  }
}

// Stop server
POST /api/runtime/stop
```

### Logging

```typescript
// Get logs
GET /api/runtime/logs
POST /api/runtime/logs
Query: {
  since?: timestamp,
  level?: 'all' | LogLevel,
  agentName?: string,
  agentId?: string,
  limit?: number
}
Response: {
  logs: LogEntry[],
  count: number,
  total: number,
  levels: string[]
}

// Clear logs
DELETE /api/runtime/logs
```

### Debug

```typescript
// Get message servers (debug)
GET /api/runtime/debug/servers
Response: {
  servers: MessageServer[],
  count: number
}
```

## System Configuration (`/api/system`)

### Environment Management

```typescript
// Get local environment variables
GET /api/system/env/local
Response: { [key: string]: string }

// Update local environment
POST /api/system/env/local
Body: { content: { [key: string]: string } }
```

## WebSocket Communication

### Connection

```javascript
const socket = io('http://localhost:3000', {
  transports: ['websocket'],
});

socket.on('connection_established', (data) => {
  console.log('Connected:', data.socketId);
});
```

### Channel Operations

```javascript
// Join channel
socket.emit('1', {  // ROOM_JOINING = 1
  channelId: UUID,
  agentId?: UUID,
  entityId?: UUID,
  serverId?: UUID,
  metadata?: object
});

// Send message
socket.emit('2', {  // SEND_MESSAGE = 2
  channelId: UUID,
  senderId: UUID,
  senderName: string,
  message: string,
  serverId: UUID,
  source?: string,
  metadata?: object,
  attachments?: any[]
});
```

### Events

```javascript
// Message broadcast
socket.on('messageBroadcast', (data) => {
  // { senderId, senderName, text, channelId, serverId, createdAt, source, id }
});

// Channel events
socket.on('channel_joined', (data) => {});
socket.on('messageComplete', (data) => {});
socket.on('messageDeleted', (data) => {});
socket.on('channelCleared', (data) => {});
socket.on('controlMessage', (data) => {
  // { action: 'enable_input' | 'disable_input', channelId }
});
```

### Log Streaming

```javascript
// Subscribe to logs
socket.emit('subscribe_logs');

// Update filters
socket.emit('update_log_filters', {
  agentName?: string,
  level?: string
});

// Receive logs
socket.on('log_stream', (data) => {
  // { type: 'log_entry', payload: LogEntry }
});

// Unsubscribe
socket.emit('unsubscribe_logs');
```

## Internal Services

### Message Bus Service

Handles internal message distribution between agents:

```typescript
// Listens for events
internalMessageBus.on('new_message', handler);
internalMessageBus.on('server_agent_update', handler);
internalMessageBus.on('message_deleted', handler);
internalMessageBus.on('channel_cleared', handler);
```

### File Upload Security

- Path traversal prevention
- Filename sanitization
- MIME type validation
- File size limits
- Secure directory structure

### Rate Limiting

- **General API**: 1000 requests/15min
- **File operations**: 100 requests/5min
- **Upload operations**: 50 uploads/15min
- **Channel validation**: 200 attempts/10min

## Error Responses

Standard error format:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": "Additional information"
  }
}
```

Common error codes:

- `INVALID_ID`: Invalid UUID format
- `NOT_FOUND`: Resource not found
- `BAD_REQUEST`: Invalid request data
- `RATE_LIMIT_EXCEEDED`: Too many requests
- `FILE_TOO_LARGE`: Upload exceeds limit
- `INVALID_FILE_TYPE`: Unsupported file type

## Plugin Routes

Plugins can register custom HTTP routes:

```typescript
plugin.routes = [
  {
    path: '/my-route',
    type: 'GET',
    public: true,
    name: 'My Panel',
    handler: (req, res, runtime) => {
      res.json({ data: 'response' });
    },
  },
];
```

Access via: `/api/my-route?agentId=UUID`

## Best Practices

1. **Always validate UUIDs** before operations
2. **Use appropriate HTTP methods** (GET for reads, POST for creates, etc.)
3. **Include error handling** for all requests
4. **Set appropriate timeouts** for long operations
5. **Use multipart/form-data** for file uploads
6. **Include agentId** in queries for agent-specific operations
7. **Handle WebSocket disconnections** gracefully
8. **Implement retry logic** for critical operations
9. **Monitor rate limits** to avoid blocking
10. **Use authentication** in production environments

## Project Structure

A standard ElizaOS project has the following structure, created by `elizaos create`.

```
my-project/
├── .env                  # Environment variables (API keys, DB URLs)
├── .gitignore            # Standard git ignore for Node.js projects
├── .elizadb/             # PGLite database files (if using PGLite)
├── bun.lockb             # Bun lockfile
├── package.json          # Project definition and dependencies
├── tsconfig.json         # TypeScript configuration
├── src/
│   ├── index.ts          # Main project entry point
│   ├── agents/           # Agent character definitions
│   │   └── my-agent.ts
│   └── plugins/          # Project-specific plugins
│       └── my-plugin.ts
├── knowledge/            # Knowledge files for agents
└── dist/                 # Compiled output
```

## Core Implementation Patterns

### Creating a New Project

The `elizaos create` command is the unified entry point for creating projects, plugins, or standalone agent character files.

```bash
# ✅ DO: Use the interactive `create` command
elizaos create

# ✅ DO: Create a new project non-interactively
elizaos create my-new-project --type project --yes

# ✅ DO: Create a new plugin
elizaos create my-new-plugin --type plugin

# ✅ DO: Create a project in the current directory
elizaos create .

# ❌ DON'T: Manually create project directories and files.
# The `create` command handles templates, dependencies, and initial configuration.
```

The interactive `create` command will guide you through:

1.  **Choosing a type**: Project, Plugin, or Agent.
2.  **Naming**: Providing a valid npm package name.
3.  **Database Selection**: Choosing between PGLite (development) and PostgreSQL (production).
4.  **AI Model Selection**: Choosing between Local AI, OpenAI, or Anthropic.

### Starting a Project

The `elizaos start` command is used to run your project or test your plugin. It automatically detects the context (project or plugin) in the current directory.

```bash
# ✅ DO: Start the project from its root directory
cd my-new-project
elizaos start

# ✅ DO: Start and automatically build the project first
elizaos start --build

# ✅ DO: Specify a port for the server
elizaos start --port 4000

# ❌ DON'T: Run start from outside a project/plugin directory.
# It relies on the local `package.json` and file structure to work correctly.
```

### Building a Project

Projects need to be built (transpiled from TypeScript to JavaScript) before they can be run in production. The build step is often handled automatically by `start`, but can be run manually.

```bash
# ✅ DO: Manually build a project
elizaos build

# ✅ DO: Manually build a plugin
# The command is the same, it detects the context.
elizaos build

# The `build` command is a wrapper around `tsup` or a similar bundler
# defined in your project's `package.json`.
```

### Managing Dependencies

Project dependencies, including plugins, are managed in `package.json`. Use `bun` to manage them. Core ElizaOS plugins are scoped under `@elizaos`.

```bash
# ✅ DO: Add a new ElizaOS plugin to your project
bun add @elizaos/plugin-openai

# ✅ DO: Add a local plugin using a file path
bun add ../path/to/my-local-plugin

# After adding a plugin to package.json, you must register it
# with an agent in your project's main entry point (e.g., `src/index.ts`).
# The `start` command will handle installing any missing plugins.

# ❌ DON'T: Manually edit `bun.lockb`. Use the `bun` command.
```

## Advanced Patterns

### Project Entry Point (`src/index.ts`)

The project entry point is where you define your agents and associate them with plugins. The `start` command executes this file.

```typescript
// src/index.ts

import { myAgentCharacter } from './agents/my-agent';
import { myProjectPlugin } from './plugins/my-plugin';
import { type Project } from '@elizaos/core';

// ✅ DO: Define a project with one or more agents
const project: Project = {
  agents: [
    {
      character: myAgentCharacter,
      // List all plugins the agent should use
      plugins: [
        '@elizaos/plugin-sql',
        '@elizaos/plugin-openai',
        myProjectPlugin, // A local plugin
      ],
      // Optional init function for the agent
      init: (runtime) => {
        console.log(`Agent ${runtime.character.name} initialized!`);
      },
    },
  ],
};

// ✅ DO: Export the project as the default export
export default project;
```

### Loading Multiple Characters

The `start` command can load one or more standalone character files, overriding the project's default agents. This is useful for testing or running different agent configurations without changing the code.

```bash
# ✅ DO: Load a single character file
elizaos start --character ./path/to/my-agent.json

# ✅ DO: Load multiple character files
elizaos start --character ./agent1.json ./agent2.json

# ✅ DO: Load characters using comma-separated values
elizaos start --character="./agent1.json, ./agent2.json"

# Note: When using --character, the agents defined in your
# project's `src/index.ts` will be ignored.
```

### Non-Interactive Mode

For CI/CD or automated environments, use the `-y` (`--yes`) flag with `create` to skip all interactive prompts and use default values.

```bash
# ✅ DO: Create a project non-interactively
elizaos create my-ci-project --type project --yes

# ✅ DO: Create a plugin non-interactively
elizaos create my-ci-plugin --type plugin --yes
```

This will create a project/plugin with default settings:

- **Database**: PGLite
- **AI Model**: Local AI

Placeholders for API keys will be added to the `.env` file, which you can then populate using environment variables in your CI/CD system.

## References

- [ElizaOS CLI Documentation](https:/eliza.how/docs/cli)
- [Managing Agents](elizaos_v2_cli_agents.mdc)
- [Project Configuration](elizaos_v2_cli_config.mdc)

      throw new ProjectValidationError(
        `Command must be run inside an ElizaOS project directory. ` +
        `Current directory: ${getDirectoryTypeDescription(directoryInfo)}`
      );

  }

  // Normalize plugin name and resolve package
  const normalizedName = normalizePluginNameForDisplay(pluginArg);
  const packageName = await resolvePluginPackage(pluginArg, opts);

  console.log(`Installing plugin: ${normalizedName}`);

  // Install plugin with dependency resolution
  await installPlugin(packageName, {
  branch: opts.branch,
  tag: opts.tag,
  skipEnvPrompt: opts.noEnvPrompt,
  cwd
  });

  // Update project configuration
  await updateProjectConfig(cwd, packageName);

  console.log(`✅ Plugin ${normalizedName} installed successfully`);
  });

// Plugin removal with cleanup
plugins
.command('remove')
.alias('delete')
.description('Remove a plugin from the project')
.argument('<plugin>', 'Plugin name to remove')
.action(async (pluginArg: string) => {
const cwd = process.cwd();
const allDependencies = getDependenciesFromDirectory(cwd);

    if (!allDependencies) {
      throw new ProjectValidationError('Could not read project dependencies');
    }

    const packageName = findPluginPackageName(pluginArg, allDependencies);

    if (!packageName) {
      throw new PluginNotFoundError(`Plugin "${pluginArg}" not found in dependencies`);
    }

    // Remove plugin and clean up configuration
    await removePlugin(packageName, cwd);
    await cleanupPluginConfig(cwd, packageName);

    console.log(`✅ Plugin ${pluginArg} removed successfully`);

});

// ❌ DON'T: Install plugins without validation or proper error handling
plugins
.command('bad-add')
.action(async (plugin: string) => {
// No validation, no dependency resolution, no error handling
await execa('npm', ['install', plugin]);
});

````

### Development Workflow Commands

```typescript
// ✅ DO: Implement comprehensive development server with hot reload and configuration
export const dev = new Command()
  .name('dev')
  .description('Start the project in development mode')
  .option('-c, --configure', 'Reconfigure services and AI models')
  .option('-char, --character [paths...]', 'Character file(s) to use')
  .option('-b, --build', 'Build the project before starting')
  .option('-p, --port <port>', 'Port to listen on', parseInt)
  .action(async (opts) => {
    try {
      const projectConfig = await loadProjectConfiguration();

      // Build project if requested
      if (opts.build) {
        console.log('Building project...');
        await buildProject();
      }

      // Handle character file configuration
      const characterPaths = await resolveCharacterPaths(opts.character);

      // Setup development environment
      const devConfig = {
        port: opts.port || projectConfig.defaultPort || 3000,
        characters: characterPaths,
        hotReload: true,
        watch: ['src/**/*.ts', 'characters/**/*.json'],
        env: 'development'
      };

      // Start development server with hot reload
      await startDevelopmentServer(devConfig);

      // Setup file watchers for auto-reload
      setupFileWatchers(devConfig.watch, () => {
        console.log('Changes detected, reloading...');
        restartServer();
      });

      console.log(`🚀 Development server running on port ${devConfig.port}`);
      console.log(`📁 Characters: ${characterPaths.join(', ')}`);

    } catch (error) {
      handleDevelopmentError(error);
    }
  });

// Character path resolution with validation
async function resolveCharacterPaths(characterInput?: string[]): Promise<string[]> {
  if (!characterInput || characterInput.length === 0) {
    // Look for default character files
    const defaultPaths = [
      'characters/default.json',
      'character.json',
      'src/character.json'
    ];

    for (const defaultPath of defaultPaths) {
      if (await fs.access(defaultPath).then(() => true).catch(() => false)) {
        return [defaultPath];
      }
    }

    throw new ConfigurationError('No character files found. Use --character to specify files.');
  }

  const resolvedPaths: string[] = [];

  for (const input of characterInput) {
    if (input.startsWith('http')) {
      // Remote character file
      resolvedPaths.push(input);
    } else {
      // Local file - add .json extension if missing
      const path = input.endsWith('.json') ? input : `${input}.json`;

      if (await fs.access(path).then(() => true).catch(() => false)) {
        resolvedPaths.push(path);
      } else {
        throw new FileNotFoundError(`Character file not found: ${path}`);
      }
    }
  }

  return resolvedPaths;
}

// Production start command
export const start = new Command()
  .name('start')
  .description('Start the project in production mode')
  .option('-p, --port <port>', 'Port to listen on', parseInt)
  .option('-char, --character [paths...]', 'Character file(s) to use')
  .action(async (opts) => {
    try {
      const projectConfig = await loadProjectConfiguration();
      const characterPaths = await resolveCharacterPaths(opts.character);

      const prodConfig = {
        port: opts.port || process.env.PORT || projectConfig.defaultPort || 3000,
        characters: characterPaths,
        env: 'production',
        clustering: projectConfig.clustering || false
      };

      console.log('🚀 Starting ElizaOS in production mode...');
      await startProductionServer(prodConfig);

    } catch (error) {
      handleProductionError(error);
    }
  });

// ❌ DON'T: Start development without proper configuration or error handling
export const badDev = new Command()
  .action(async () => {
    // No configuration, no character handling, no error handling
    require('./src/index.js');
  });
````

## Error Handling and Validation

### Custom Error Classes

```typescript
// ✅ DO: Implement specific error types for different failure scenarios
export class ProjectValidationError extends Error {
  constructor(
    message: string,
    public context?: Record<string, any>
  ) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

export class PluginInstallationError extends Error {
  constructor(
    message: string,
    public pluginName: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'PluginInstallationError';
  }
}

export class PluginNotFoundError extends Error {
  constructor(
    message: string,
    public pluginName: string
  ) {
    super(message);
    this.name = 'PluginNotFoundError';
  }
}

export class ConfigurationError extends Error {
  constructor(
    message: string,
    public configType?: string
  ) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export class FileNotFoundError extends Error {
  constructor(
    message: string,
    public filePath: string
  ) {
    super(message);
    this.name = 'FileNotFoundError';
  }
}

// Centralized error handler
export function handleCreateError(error: unknown): never {
  if (error instanceof ProjectValidationError) {
    console.error(`❌ Project validation failed: ${error.message}`);
    if (error.context) {
      console.error('Context:', error.context);
    }
  } else if (error instanceof PluginInstallationError) {
    console.error(`❌ Plugin installation failed: ${error.message}`);
    console.error(`Plugin: ${error.pluginName}`);
    if (error.cause) {
      console.error('Caused by:', error.cause.message);
    }
  } else if (error instanceof ConfigurationError) {
    console.error(`❌ Configuration error: ${error.message}`);
    if (error.configType) {
      console.error(`Configuration type: ${error.configType}`);
    }
  } else {
    console.error(`❌ Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  }

  process.exit(1);
}
```

### Validation Patterns

```typescript
// ✅ DO: Implement comprehensive validation for project names and configurations
export const validateProjectName = (name: string): boolean => {
  // Check for valid npm package name
  const npmPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

  if (!npmPattern.test(name)) {
    throw new ProjectValidationError(
      'Project name must be a valid npm package name (lowercase, no spaces, can contain hyphens)'
    );
  }

  // Check for reserved names
  const reservedNames = ['elizaos', 'eliza', 'node_modules', 'package'];
  if (reservedNames.includes(name.toLowerCase())) {
    throw new ProjectValidationError(`Project name "${name}" is reserved`);
  }

  return true;
};

export const validatePluginName = (name: string): boolean => {
  // Normalize and validate plugin name
  const normalized = normalizePluginNameForDisplay(name);

  if (normalized.length < 3) {
    throw new ProjectValidationError('Plugin name must be at least 3 characters long');
  }

  return true;
};

// Directory type detection and validation
export interface DirectoryInfo {
  hasPackageJson: boolean;
  hasElizaConfig: boolean;
  isElizaProject: boolean;
  isPlugin: boolean;
  projectType: 'eliza-project' | 'plugin' | 'other' | 'empty';
}

export function detectDirectoryType(dir: string): DirectoryInfo {
  const packageJsonPath = path.join(dir, 'package.json');
  const elizaConfigPath = path.join(dir, 'elizaos.config.js');

  const hasPackageJson = fs.existsSync(packageJsonPath);
  const hasElizaConfig = fs.existsSync(elizaConfigPath);

  let isElizaProject = false;
  let isPlugin = false;
  let projectType: DirectoryInfo['projectType'] = 'empty';

  if (hasPackageJson) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      isElizaProject = !!packageJson.dependencies?.['@elizaos/core'];
      isPlugin = packageJson.name?.startsWith('plugin-') || packageJson.name?.includes('/plugin-');

      if (isElizaProject) {
        projectType = isPlugin ? 'plugin' : 'eliza-project';
      } else {
        projectType = 'other';
      }
    } catch {
      projectType = 'other';
    }
  }

  return {
    hasPackageJson,
    hasElizaConfig,
    isElizaProject,
    isPlugin,
    projectType,
  };
}

// ❌ DON'T: Skip validation or use weak checks
export const badValidation = (name: string): boolean => {
  return name.length > 0; // Too weak, allows invalid names
};
```

## Plugin Name Resolution

### Name Normalization Patterns

```typescript
// ✅ DO: Implement comprehensive plugin name normalization and resolution
export const normalizePluginNameForDisplay = (pluginInput: string): string => {
  let baseName = pluginInput;

  // Handle scoped formats like "@scope/plugin-name" or "scope/plugin-name"
  if (pluginInput.includes('/')) {
    const parts = pluginInput.split('/');
    baseName = parts[parts.length - 1];
  }
  // Handle "@plugin-name" format
  else if (pluginInput.startsWith('@')) {
    baseName = pluginInput.substring(1);
  }

  // Ensure it starts with 'plugin-' and remove duplicates
  baseName = baseName.replace(/^plugin-/, '');
  return `plugin-${baseName}`;
};

export const findPluginPackageName = (
  pluginInput: string,
  allDependencies: Record<string, string>
): string | null => {
  const normalizedBase = pluginInput
    .replace(/^@[^/]+\//, '') // Remove scope
    .replace(/^plugin-/, ''); // Remove prefix

  // Potential package names to check in order of preference
  const possibleNames = [
    pluginInput, // Check raw input first
    `@elizaos/plugin-${normalizedBase}`, // Official scope
    `@elizaos-plugins/plugin-${normalizedBase}`, // Alternative scope
    `plugin-${normalizedBase}`, // Unscoped
    `@elizaos/${normalizedBase}`, // Official without plugin prefix
    `@elizaos-plugins/${normalizedBase}`, // Alternative without prefix
  ];

  for (const name of possibleNames) {
    if (allDependencies[name]) {
      return name;
    }
  }

  return null;
};

// Registry-based resolution with fallback
export async function resolvePluginPackage(
  pluginInput: string,
  opts: { branch?: string; tag?: string }
): Promise<string> {
  try {
    const registry = await fetchPluginRegistry();

    if (registry?.registry[pluginInput]) {
      const pluginInfo = registry.registry[pluginInput];

      // Use tag-specific version if available
      if (opts.tag && pluginInfo.npm?.tags?.[opts.tag]) {
        return `${pluginInput}@${pluginInfo.npm.tags[opts.tag]}`;
      }

      // Use latest compatible version
      const latestVersion = pluginInfo.npm?.v1 || pluginInfo.npm?.v0;
      if (latestVersion) {
        return `${pluginInput}@${latestVersion}`;
      }
    }

    // Fallback to normalized name
    return normalizePluginNameForDisplay(pluginInput);
  } catch (error) {
    console.warn('Could not fetch plugin registry, using normalized name');
    return normalizePluginNameForDisplay(pluginInput);
  }
}

// ❌ DON'T: Use simple string replacement without proper validation
export const badNormalization = (name: string): string => {
  return name.replace('plugin-', ''); // Loses important context
};
```

## Performance Optimization

### Dependency Installation Optimization

```typescript
// ✅ DO: Implement optimized dependency installation with parallel processing
export async function installDependencies(
  targetDir: string,
  options?: {
    skipOptional?: boolean;
    parallel?: boolean;
    timeout?: number;
  }
): Promise<void> {
  const opts = {
    skipOptional: true,
    parallel: true,
    timeout: 300000, // 5 minutes
    ...options,
  };

  console.log('📦 Installing dependencies...');
  const startTime = Date.now();

  try {
    const installArgs = ['install'];

    if (opts.skipOptional) {
      installArgs.push('--no-optional');
    }

    if (opts.parallel) {
      installArgs.push('--parallel');
    }

    await runBunCommand(installArgs, targetDir, {
      timeout: opts.timeout,
      stdio: 'inherit',
    });

    const duration = Date.now() - startTime;
    console.log(`✅ Dependencies installed in ${(duration / 1000).toFixed(1)}s`);
  } catch (error) {
    console.warn(
      'Failed to install dependencies automatically. ' +
        'Please run "bun install" manually in the project directory.'
    );
    throw new PluginInstallationError(
      'Dependency installation failed',
      'dependencies',
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

// Cache plugin registry to avoid repeated network calls
let registryCache: any = null;
let registryCacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export async function fetchPluginRegistry(): Promise<any> {
  const now = Date.now();

  if (registryCache && now - registryCacheTime < CACHE_DURATION) {
    return registryCache;
  }

  try {
    const response = await fetch(PLUGIN_REGISTRY_URL, {
      timeout: 10000, // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(`Registry fetch failed: ${response.statusText}`);
    }

    registryCache = await response.json();
    registryCacheTime = now;

    return registryCache;
  } catch (error) {
    if (registryCache) {
      console.warn('Using cached registry due to fetch error');
      return registryCache;
    }
    throw error;
  }
}

// ❌ DON'T: Install dependencies without optimization or error handling
export async function badInstallDependencies(dir: string): Promise<void> {
  // No error handling, no optimization, no feedback
  await execa('npm', ['install'], { cwd: dir });
}
```

## Anti-patterns and Common Mistakes

### Command Structure Anti-patterns

```typescript
// ❌ DON'T: Create commands without proper option validation or help
const badCommand = new Command().name('bad').action(async (options) => {
  // No validation, no error handling, no help
  console.log('Doing something...');
});

// ❌ DON'T: Mix command concerns or create overly complex commands
const confusedCommand = new Command().name('confused').action(async (options) => {
  // Doing project creation, plugin management, AND deployment
  await createProject();
  await installPlugins();
  await deployToProduction();
});

// ✅ DO: Create focused, well-documented commands with proper validation
const goodCommand = new Command()
  .name('create-project')
  .description('Create a new ElizaOS project with specified configuration')
  .argument('<name>', 'Project name (must be valid npm package name)')
  .option('-d, --dir <directory>', 'Target directory for project creation', '.')
  .option('-t, --template <template>', 'Project template to use', 'default')
  .addHelpText(
    'after',
    `
Examples:
  $ elizaos create-project my-agent
  $ elizaos create-project my-agent --dir ./projects --template advanced
  `
  )
  .action(async (name: string, options) => {
    try {
      validateProjectName(name);
      await createProject(name, options);
    } catch (error) {
      handleCreateError(error);
    }
  });
```

### Error Handling Anti-patterns

```typescript
// ❌ DON'T: Swallow errors or provide unhelpful error messages
async function badErrorHandling() {
  try {
    await riskyOperation();
  } catch (error) {
    console.log('Something went wrong'); // No context
    return; // Silent failure
  }
}

// ❌ DON'T: Throw generic errors without context
function badValidation(name: string) {
  if (!name) {
    throw new Error('Invalid'); // No helpful information
  }
}

// ✅ DO: Provide contextual error messages with recovery suggestions
async function goodErrorHandling() {
  try {
    await riskyOperation();
  } catch (error) {
    if (error instanceof NetworkError) {
      console.error('❌ Network error occurred. Please check your internet connection.');
      console.error('💡 Try running "elizaos plugins update" to refresh the registry.');
    } else if (error instanceof ValidationError) {
      console.error(`❌ Validation failed: ${error.message}`);
      console.error('💡 Check the project name and try again.');
    } else {
      console.error('❌ Unexpected error occurred');
      console.error(`Details: ${error.message}`);
      console.error('💡 Please report this issue if it persists.');
    }
    process.exit(1);
  }
}
```

## Best Practices Summary

### Command Design

- Use focused, single-purpose commands
- Provide comprehensive help and examples
- Implement proper argument and option validation
- Use aliases for commonly used commands

### Error Handling

- Create specific error types for different scenarios
- Provide contextual error messages with suggested solutions
- Implement graceful fallbacks where possible
- Log errors with appropriate detail levels

### Performance

- Cache registry data to avoid repeated network calls
- Use parallel processing for dependency installation
- Implement timeouts for network operations
- Provide progress feedback for long-running operations

### User Experience

- Use interactive prompts for better developer experience
- Provide sensible defaults for all options
- Show clear success and progress messages
- Include helpful examples in command descriptions

### Configuration Management

- Support both interactive and non-interactive modes
- Validate all configuration before processing
- Use environment variables for sensitive data
- Provide configuration templates and examples

## References

- [ElizaOS CLI Source](Users/ilessio/dev-agents/PROJECTS/cursor_rules/eliza/packages/cli/src)
- [Commander.js Documentation](https:/github.com/tj/commander.js)
- [Project Creation Patterns](Users/ilessio/dev-agents/PROJECTS/cursor_rules/eliza/packages/cli/src/commands/create.ts)
- [Plugin Management System](Users/ilessio/dev-agents/PROJECTS/cursor_rules/eliza/packages/cli/src/commands/plugins.ts)
- [Development Workflow Commands](Users/ilessio/dev-agents/PROJECTS/cursor_rules/eliza/packages/cli/src/commands/dev.ts)

# ElizaOS Entities System

Entities represent users, agents, or any participant that can interact within the system. They form the basis of the entity-component architecture, allowing for flexible data modeling and relationships.

## Core Concepts

### Entity Structure

```typescript
interface Entity {
  id?: UUID; // Unique identifier (optional on creation)
  names: string[]; // Array of names/aliases
  metadata?: { [key: string]: any }; // Additional information
  agentId: UUID; // Related agent ID
  components?: Component[]; // Modular data components
}
```

### Component Structure

Components are modular data pieces attached to entities:

```typescript
interface Component {
  id: UUID; // Unique identifier
  entityId: UUID; // Parent entity ID
  agentId: UUID; // Managing agent ID
  roomId: UUID; // Associated room
  worldId: UUID; // Associated world
  sourceEntityId: UUID; // Creator entity ID
  type: string; // Component type (profile, settings, etc)
  data: { [key: string]: any }; // Component data
}
```

## Entity Management

### Creating Entities

```typescript
// Create new entity
const entityId = await runtime.createEntity({
  names: ['John Doe', 'JohnD'],
  agentId: runtime.agentId,
  metadata: {
    discord: {
      username: 'john_doe',
      name: 'John Doe',
    },
  },
});

// Create with specific ID
await runtime.createEntity({
  id: customUuid,
  names: ['Agent Smith'],
  agentId: runtime.agentId,
  metadata: {
    type: 'ai_agent',
    version: '1.0',
  },
});
```

### Retrieving Entities

```typescript
// Get by ID
const entity = await runtime.getEntityById(entityId);

// Get all entities in a room (with components)
const entitiesInRoom = await runtime.getEntitiesForRoom(roomId, true);

// Get multiple by IDs
const entities = await runtime.getEntityByIds([id1, id2, id3]);
```

### Updating Entities

```typescript
await runtime.updateEntity({
  id: entityId,
  names: [...entity.names, 'Johnny'], // Add new alias
  metadata: {
    ...entity.metadata,
    customProperty: 'value',
  },
});
```

## Component System

Components enable flexible data modeling:

### Creating Components

```typescript
// Create profile component
await runtime.createComponent({
  id: componentId,
  entityId: entityId,
  agentId: runtime.agentId,
  roomId: roomId,
  worldId: worldId,
  sourceEntityId: creatorEntityId,
  type: 'profile',
  data: {
    bio: 'Software developer interested in AI',
    location: 'San Francisco',
    website: 'https://example.com',
  },
});

// Create settings component
await runtime.createComponent({
  id: settingsId,
  entityId: entityId,
  agentId: runtime.agentId,
  roomId: roomId,
  worldId: worldId,
  sourceEntityId: entityId,
  type: 'settings',
  data: {
    notifications: true,
    theme: 'dark',
    language: 'en',
  },
});
```

### Retrieving Components

```typescript
// Get specific component type
const profile = await runtime.getComponent(
  entityId,
  'profile',
  worldId, // optional filter
  sourceEntityId // optional filter
);

// Get all components for entity
const allComponents = await runtime.getComponents(
  entityId,
  worldId, // optional
  sourceEntityId // optional
);
```

### Managing Components

```typescript
// Update component
await runtime.updateComponent({
  id: profileComponent.id,
  data: {
    ...profileComponent.data,
    bio: 'Updated bio information',
  },
});

// Delete component
await runtime.deleteComponent(componentId);
```

## Entity Relationships

Entities can have relationships with other entities:

### Creating Relationships

```typescript
await runtime.createRelationship({
  sourceEntityId: entityId1,
  targetEntityId: entityId2,
  tags: ['friend', 'collaborator'],
  metadata: {
    interactions: 5,
    lastInteraction: Date.now(),
  },
});
```

### Managing Relationships

```typescript
// Get relationships
const relationships = await runtime.getRelationships({
  entityId: entityId1,
  tags: ['friend'], // optional filter
});

// Get specific relationship
const relationship = await runtime.getRelationship({
  sourceEntityId: entityId1,
  targetEntityId: entityId2,
});

// Update relationship
await runtime.updateRelationship({
  ...relationship,
  metadata: {
    ...relationship.metadata,
    interactions: relationship.metadata.interactions + 1,
    lastInteraction: Date.now(),
  },
});
```

## Entity Resolution

Find entities by name or reference:

```typescript
import { findEntityByName } from '@elizaos/core';

// Resolve entity from message context
const entity = await findEntityByName(runtime, message, state);
```

Resolution considers:

- Exact ID matches
- Username matches
- Recent conversation context
- Relationship strength
- World role permissions

## Entity Details

Format entity information:

```typescript
import { getEntityDetails, formatEntities } from '@elizaos/core';

// Get detailed entity information
const entityDetails = await getEntityDetails({
  runtime,
  roomId,
});

// Format entities for display
const formatted = formatEntities({
  entities: entitiesInRoom,
});
```

## Unique ID Generation

Create deterministic IDs for entity-agent pairs:

```typescript
import { createUniqueUuid } from '@elizaos/core';

// Generate consistent ID
const uniqueId = createUniqueUuid(runtime, baseUserId);
```

## Common Patterns

### User Entity

```typescript
const userEntity = {
  names: [userName, displayName],
  metadata: {
    platform: {
      id: platformUserId,
      username: userName,
      avatar: avatarUrl,
    },
    joinedAt: Date.now(),
  },
  agentId: runtime.agentId,
};
```

### Agent Entity

```typescript
const agentEntity = {
  id: agentId,
  names: [agentName],
  metadata: {
    type: 'agent',
    capabilities: ['chat', 'voice'],
    version: '1.0.0',
  },
  agentId: agentId, // Self-reference
};
```

### Multi-Platform Entity

```typescript
const multiPlatformEntity = {
  names: ['JohnDoe', 'john_doe', 'JD'],
  metadata: {
    discord: {
      id: discordId,
      username: 'john_doe#1234',
    },
    twitter: {
      id: twitterId,
      handle: '@johndoe',
    },
    telegram: {
      id: telegramId,
      username: 'john_doe_tg',
    },
  },
  agentId: runtime.agentId,
};
```

## Best Practices

1. **Meaningful Names**: Use descriptive names in the array
2. **Metadata Structure**: Organize by source/platform
3. **Component Usage**: Use components for modular data
4. **Permission Checking**: Verify before accessing components
5. **Relationship Updates**: Keep interaction metadata current
6. **Entity Resolution**: Use provided utilities
7. **Unique IDs**: Use `createUniqueUuid` for consistency

## Entity-Component Benefits

- **Flexibility**: Add new data types without schema changes
- **Modularity**: Components can be independently managed
- **Multi-tenancy**: Different agents can manage different components
- **Extensibility**: Plugins can define custom component types
- **Performance**: Load only needed components

Current anthropic models:
Claude Opus 4 claude-opus-4-20250514
Claude Sonnet 4 claude-sonnet-4-20250514

Current OpenAI models:
'gpt-4o'
'gpt-4o-mini'
'o1-2024-12-17'

# ElizaOS Database System

The ElizaOS database system provides persistent storage capabilities for agents through a flexible adapter-based architecture. It handles memory storage, entity relationships, knowledge management, and more.

## Core Concepts

### Architecture

### Current Adapters

| **PGLite** | Local development & testing | Lightweight PostgreSQL in Node.js process |
| **PostgreSQL** | Production deployments | Full PostgreSQL with vector search, scaling |

## Database Operations

### Entity System

```typescript
// Create entity
await adapter.createEntity(entity);

// Get entity
const entity = await adapter.getEntityById(id);
const entities = await adapter.getEntitiesForRoom(roomId);

// Update entity
await adapter.updateEntity(entity);

// Components
await adapter.createComponent(component);
const component = await adapter.getComponent(entityId, type);
await adapter.updateComponent(component);
await adapter.deleteComponent(componentId);
```

### Memory Management

```typescript
// Create memory
const memoryId = await adapter.createMemory(memory, 'messages');

// Get memories
const memories = await adapter.getMemories({
  roomId,
  count: 50,
  unique: true,
});

// Search memories
const relevant = await adapter.searchMemories({
  embedding: vector,
  roomId,
  match_threshold: 0.8,
  count: 10,
});

// Delete memories
await adapter.deleteMemory(memoryId);
await adapter.deleteAllMemories(roomId, 'messages');
```

### Room & Participant Management

```typescript
// Rooms
await adapter.createRoom(room);
const room = await adapter.getRoom(roomId);
await adapter.updateRoom(room);
await adapter.deleteRoom(roomId);

// Participants
await adapter.addParticipant(entityId, roomId);
await adapter.removeParticipant(entityId, roomId);
const participants = await adapter.getParticipantsForRoom(roomId);
const state = await adapter.getParticipantUserState(roomId, entityId);
await adapter.setParticipantUserState(roomId, entityId, 'FOLLOWED');
```

### Relationships

```typescript
// Create relationship
await adapter.createRelationship({
  sourceEntityId,
  targetEntityId,
  tags: ['friend', 'collaborator'],
  metadata: { trust: 0.8 },
});

// Get relationships
const relationships = await adapter.getRelationships({
  entityId,
  tags: ['friend'],
});

// Update relationship
await adapter.updateRelationship(relationship);
```

### Caching

```typescript
// Set cache
await adapter.setCache('key', { data: 'value' });

// Get cache
const cached = await adapter.getCache<MyType>('key');

// Delete cache
await adapter.deleteCache('key');
```

### World & Task Management

```typescript
// Worlds
await adapter.createWorld(world);
const world = await adapter.getWorld(worldId);
await adapter.updateWorld(world);
await adapter.removeWorld(worldId);

// Tasks
await adapter.createTask(task);
const tasks = await adapter.getTasks({ roomId, tags });
await adapter.updateTask(taskId, updates);
await adapter.deleteTask(taskId);
```

## Configuration

### Environment Variables

```bash
# PostgreSQL
POSTGRES_URL=postgresql://user:pass@localhost:5432/elizaos

# PGLite (optional)
SQLITE_DATA_DIR=./.elizadb  # Default: ./sqlite
```

### Initialization

The SQL plugin handles adapter initialization:

```typescript
// Plugin automatically selects adapter based on config
const plugin = '@elizaos/plugin-sql';

// Will use PostgreSQL if POSTGRES_URL is set
// Otherwise defaults to PGLite
```

## Retry Logic

Built-in retry with exponential backoff:

```typescript
protected async withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let attempt = 0;

  while (attempt < this.maxRetries) {
    try {
      return await operation();
    } catch (error) {
      if (!this.isRetryableError(error)) {
        throw error;
      }

      const delay = Math.min(
        this.baseDelay * Math.pow(2, attempt) +
        Math.random() * this.jitterMax,
        this.maxDelay
      );

      await new Promise(resolve => setTimeout(resolve, delay));
      attempt++;
    }
  }

  throw lastError;
}
```

## Vector Search

Both adapters support semantic search:

```typescript
// Store with embedding
await runtime.createMemory(
  {
    content: { text: 'Important information' },
    embedding: await runtime.useModel(ModelType.TEXT_EMBEDDING, {
      text: 'Important information',
    }),
    roomId,
  },
  'facts'
);

// Search by similarity
const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
  text: 'What did we discuss about databases?',
});

const memories = await runtime.searchMemories({
  embedding,
  roomId,
  count: 5,
  match_threshold: 0.7,
});
```

### Embedding Dimensions

```typescript
// Configure embedding dimension (auto-detected)
await adapter.ensureEmbeddingDimension(1536); // OpenAI
```

## Database Schema

### Core Tables

- **entities**: Users, agents, participants
- **components**: Modular entity data
- **memories**: Conversation history and knowledge
- **relationships**: Entity connections
- **rooms**: Conversation channels
- **participants**: Room membership
- **worlds**: Room containers
- **tasks**: Scheduled operations
- **cache**: Temporary storage
- **agents**: Agent configuration

### Entity-Component System

```typescript
// Entity with components
const entity = {
  id: entityId,
  names: ['John Doe'],
  metadata: { platform: 'discord' },
};

// Add profile component
const profile = {
  entityId,
  type: 'profile',
  data: {
    bio: 'Developer',
    location: 'SF',
  },
};
```

## Performance Tips

### PostgreSQL

- Install pgvector extension
- Index frequently queried fields
- Use connection pooling
- Consider partitioning for scale

### PGLite

- Keep database under 1GB
- Regular memory cleanup
- Limit concurrent operations

## Common Patterns

### Singleton Connection

```typescript
// Managers ensure single connection per process
class PostgresManager {
  private static instance: PostgresManager;

  static getInstance(): PostgresManager {
    if (!this.instance) {
      this.instance = new PostgresManager();
    }
    return this.instance;
  }
}
```

### Memory with Metadata

```typescript
await runtime.createMemory(
  {
    content: {
      text: 'User prefers dark mode',
      metadata: {
        type: 'preference',
        confidence: 0.9,
      },
    },
    entityId: userId,
    roomId,
  },
  'facts'
);
```

### Bulk Operations

```typescript
// Create multiple entities efficiently
await adapter.createEntities(entityArray);

// Get multiple rooms
const rooms = await adapter.getRoomsByIds(roomIds);
```

## Migration Support

Future releases will support:

- MongoDB
- SQLite
- Supabase
- Qdrant
- SQL.js

The adapter interface is designed for extensibility.

# ElizaOS Services System

Services are long-running, stateful singleton components that manage complex functionality and external integrations. They provide a consistent interface for agents to interact with various platforms and systems.

## Core Concepts

### Service Structure

```typescript
abstract class Service {
  static serviceName: string; // Unique identifier
  static serviceType?: ServiceTypeName; // Category of service
  serviceName: string; // Instance name
  abstract capabilityDescription: string; // What the service enables
  config?: Metadata; // Service configuration

  constructor(runtime?: IAgentRuntime); // Constructor with optional runtime

  abstract stop(): Promise<void>; // Cleanup method
  static async start(runtime: IAgentRuntime): Promise<Service>; // Factory method
}
```

## Service Lifecycle

1. **Registration**: Services registered during plugin initialization
2. **Instantiation**: Single instance created via `start()` static method
3. **Configuration**: Constructor sets up initial state
4. **Runtime Access**: Available via `runtime.getService(serviceName)`
5. **Cleanup**: `stop()` called when agent shuts down

## Implementation Patterns

### Basic Service

```typescript
class DatabaseService extends Service {
  static serviceName = 'database';
  static serviceType = ServiceType.DATA_STORAGE;

  capabilityDescription = 'Provides database access';
  private connection: DatabaseConnection;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    // Initialize properties
  }

  static async start(runtime: IAgentRuntime): Promise<DatabaseService> {
    const service = new DatabaseService(runtime);
    const config = runtime.getSetting('DATABASE_URL');
    service.connection = await createConnection(config);
    runtime.logger.info('Database service initialized');
    return service;
  }

  async query(sql: string, params: any[]): Promise<any> {
    return await this.connection.query(sql, params);
  }

  async stop(): Promise<void> {
    await this.connection.close();
    this.runtime.logger.info('Database service stopped');
  }
}
```

### Platform Integration Service

```typescript
class DiscordService extends Service {
  static serviceName = 'discord';
  static serviceType = ServiceType.MESSAGING;

  capabilityDescription = 'Provides Discord integration';
  private client: DiscordClient;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<DiscordService> {
    const service = new DiscordService(runtime);
    const token = runtime.getSetting('DISCORD_TOKEN');

    service.client = new DiscordClient();
    await service.client.login(token);

    service.setupEventHandlers();
    return service;
  }

  private setupEventHandlers(): void {
    this.client.on('messageCreate', async (message) => {
      // Convert to ElizaOS message format
      const memory = await this.convertMessage(message);

      // Emit to runtime
      await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        callback: this.sendResponse.bind(this),
      });
    });
  }

  async sendMessage(channelId: string, content: Content): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    await channel.send(content.text);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }
}
```

### Blockchain Service

```typescript
class SolanaService extends Service {
  static serviceName = 'solana' as ServiceTypeName;
  static serviceType = ServiceType.BLOCKCHAIN;

  private connection: Connection;
  private wallet: Wallet;

  async initialize(runtime: IAgentRuntime): Promise<void> {
    const rpcUrl = runtime.getSetting('SOLANA_RPC_URL');
    const privateKey = runtime.getSetting('SOLANA_PRIVATE_KEY');

    this.connection = new Connection(rpcUrl);
    this.wallet = new Wallet(privateKey);
  }

  async transfer(to: string, amount: number): Promise<string> {
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: new PublicKey(to),
        lamports: amount * LAMPORTS_PER_SOL,
      })
    );

    const signature = await sendAndConfirmTransaction(this.connection, transaction, [this.wallet]);

    return signature;
  }

  async getBalance(): Promise<number> {
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    return balance / LAMPORTS_PER_SOL;
  }

  async stop(): Promise<void> {
    // Cleanup if needed
  }
}
```

## Service Types

- **MESSAGING**: Discord, Telegram, Twitter
- **BLOCKCHAIN**: Solana, Ethereum, Bitcoin
- **DATA_STORAGE**: Database, Cache, Vector Store
- **AI_MODEL**: OpenAI, Anthropic, Local Models
- **MEDIA**: Image Generation, Video Processing
- **EXTERNAL_API**: Weather, News, Market Data

## Service Discovery

```typescript
// Get specific service
const discord = runtime.getService<DiscordService>('discord');

// Get all services of a type
const messagingServices = runtime.getServicesByType(ServiceType.MESSAGING);

// Check if service exists
if (runtime.hasService('solana')) {
  const solana = runtime.getService('solana');
}
```

## Best Practices

1. **Singleton Pattern**: Services are singletons - maintain single instance
2. **Configuration**: Use `runtime.getSetting()` for config values
3. **Error Handling**: Implement robust error handling and retry logic
4. **Event Integration**: Emit runtime events for agent processing
5. **Cleanup**: Always implement proper cleanup in `stop()`
6. **Type Safety**: Use TypeScript generics for type-safe access

## Action Integration

Actions commonly use services to perform operations:

```typescript
const transferAction: Action = {
  name: 'TRANSFER_SOL',

  handler: async (runtime, message, state, options, callback) => {
    const solanaService = runtime.getService<SolanaService>('solana');
    if (!solanaService) {
      throw new Error('Solana service not available');
    }

    const { to, amount } = extractParams(message);
    const signature = await solanaService.transfer(to, amount);

    await callback({
      text: `Transferred ${amount} SOL. Signature: ${signature}`,
      thought: 'Successfully completed SOL transfer',
    });
  },
};
```

## Service Registration

Services are registered via plugins:

````typescript
const myPlugin: Plugin = {
  name: 'my-plugin',
  description: 'Plugin with custom service',
  services: [DatabaseService, CacheService],

  init: async (runtime: IAgentRuntime) => {
    // Services automatically registered and started
    const db = runtime.getService('database');
    // Use service...
  },
};

# ElizaOS Tasks System

Tasks provide a powerful way to manage deferred, scheduled, and interactive operations. They enable agents to queue work for later execution, repeat actions at intervals, await user input, and implement complex workflows.

## Core Concepts

### Task Structure

```typescript
interface Task {
  id?: UUID; // Unique identifier (auto-generated)
  name: string; // Task worker name (must match registered worker)
  updatedAt?: number; // Last update timestamp
  metadata?: {
    updateInterval?: number; // Milliseconds between executions (recurring)
    options?: {
      // Choice task options
      name: string;
      description: string;
    }[];
    [key: string]: unknown; // Additional custom metadata
  };
  description: string; // Human-readable description
  roomId?: UUID; // Optional room association
  worldId?: UUID; // Optional world association
  tags: string[]; // Categorization tags
}
````

### Task Worker

```typescript
interface TaskWorker {
  name: string; // Matches task.name
  execute: (
    runtime: IAgentRuntime,
    options: { [key: string]: unknown },
    task: Task
  ) => Promise<void>;
  validate?: (
    // Optional pre-execution validation
    runtime: IAgentRuntime,
    message: Memory,
    state: State
  ) => Promise<boolean>;
}
```

## Task Worker Registration

Workers must be registered before creating tasks:

```typescript
runtime.registerTaskWorker({
  name: 'SEND_REMINDER',

  validate: async (runtime, message, state) => {
    // Optional validation logic
    return true;
  },

  execute: async (runtime, options, task) => {
    const { roomId } = task;
    const { reminder, userId } = options;

    // Create reminder message
    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        roomId,
        content: {
          text: `Reminder for <@${userId}>: ${reminder}`,
        },
      },
      'messages'
    );

    // Delete one-time task
    await runtime.deleteTask(task.id);
  },
});
```

## Task Types

### One-time Tasks

Execute once when triggered:

```typescript
await runtime.createTask({
  name: 'SEND_REMINDER',
  description: 'Send reminder message',
  roomId: currentRoomId,
  tags: ['reminder', 'one-time'],
  metadata: {
    userId: message.entityId,
    reminder: 'Submit weekly report',
    scheduledFor: Date.now() + 86400000, // 24 hours
  },
});
```

### Recurring Tasks

Repeat at regular intervals:

```typescript
await runtime.createTask({
  name: 'DAILY_REPORT',
  description: 'Generate daily report',
  roomId: announcementChannelId,
  worldId: serverWorldId,
  tags: ['report', 'repeat', 'daily'],
  metadata: {
    updateInterval: 86400000, // 24 hours
    updatedAt: Date.now(),
  },
});
```

### Choice Tasks

Await user input with options:

```typescript
await runtime.createTask({
  name: 'CONFIRM_ACTION',
  description: 'Confirm requested action',
  roomId: message.roomId,
  tags: ['confirmation', 'AWAITING_CHOICE'],
  metadata: {
    options: [
      { name: 'confirm', description: 'Proceed with action' },
      { name: 'cancel', description: 'Cancel action' },
    ],
    action: 'DELETE_FILES',
    files: ['document1.txt', 'document2.txt'],
  },
});
```

## Task Management

```typescript
// Get tasks by criteria
const reminderTasks = await runtime.getTasks({
  roomId: currentRoomId,
  tags: ['reminder'],
});

// Get tasks by name
const reportTasks = await runtime.getTasksByName('DAILY_REPORT');

// Get specific task
const task = await runtime.getTask(taskId);

// Update task
await runtime.updateTask(taskId, {
  description: 'Updated description',
  metadata: {
    ...task.metadata,
    priority: 'high',
  },
});

// Delete task
await runtime.deleteTask(taskId);
```

## Task Processing

### Recurring Task Processing

Implement logic to check and execute recurring tasks:

```typescript
async function processRecurringTasks() {
  const now = Date.now();
  const recurringTasks = await runtime.getTasks({
    tags: ['repeat'],
  });

  for (const task of recurringTasks) {
    if (!task.metadata?.updateInterval) continue;

    const lastUpdate = task.metadata.updatedAt || 0;
    const interval = task.metadata.updateInterval;

    if (now >= lastUpdate + interval) {
      const worker = runtime.getTaskWorker(task.name);
      if (worker) {
        try {
          await worker.execute(runtime, {}, task);

          // Update last execution time
          await runtime.updateTask(task.id, {
            metadata: {
              ...task.metadata,
              updatedAt: now,
            },
          });
        } catch (error) {
          logger.error(`Error executing task ${task.name}:`, error);
        }
      }
    }
  }
}
```

## Common Task Patterns

### Deferred Follow-up

```typescript
runtime.registerTaskWorker({
  name: 'FOLLOW_UP',
  execute: async (runtime, options, task) => {
    const { roomId } = task;
    const { userId, topic } = task.metadata;

    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        roomId,
        content: {
          text: `Hi <@${userId}>, following up about ${topic}. Any updates?`,
        },
      },
      'messages'
    );

    await runtime.deleteTask(task.id);
  },
});

// Create follow-up for 2 days later
await runtime.createTask({
  name: 'FOLLOW_UP',
  description: 'Follow up on project status',
  roomId: message.roomId,
  tags: ['follow-up', 'one-time'],
  metadata: {
    userId: message.entityId,
    topic: 'the project timeline',
    scheduledFor: Date.now() + 2 * 86400000,
  },
});
```

### Multi-step Workflow

```typescript
// Step 1: Gather requirements
runtime.registerTaskWorker({
  name: 'GATHER_REQUIREMENTS',
  execute: async (runtime, options, task) => {
    // Create next step task
    await runtime.createTask({
      name: 'CONFIRM_REQUIREMENTS',
      description: 'Confirm requirements',
      roomId: task.roomId,
      tags: ['workflow', 'AWAITING_CHOICE'],
      metadata: {
        previousStep: 'GATHER_REQUIREMENTS',
        requirements: options.requirements,
        options: [
          { name: 'confirm', description: 'Requirements correct' },
          { name: 'revise', description: 'Need revision' },
        ],
      },
    });

    await runtime.deleteTask(task.id);
  },
});

// Step 2: Confirm requirements
runtime.registerTaskWorker({
  name: 'CONFIRM_REQUIREMENTS',
  execute: async (runtime, options, task) => {
    if (options.option === 'confirm') {
      // Next step
      await runtime.createTask({
        name: 'GENERATE_SOLUTION',
        description: 'Generate solution',
        roomId: task.roomId,
        tags: ['workflow'],
        metadata: {
          previousStep: 'CONFIRM_REQUIREMENTS',
          requirements: task.metadata.requirements,
        },
      });
    } else {
      // Go back
      await runtime.createTask({
        name: 'GATHER_REQUIREMENTS',
        description: 'Revise requirements',
        roomId: task.roomId,
        tags: ['workflow'],
        metadata: {
          previousStep: 'CONFIRM_REQUIREMENTS',
          previousRequirements: task.metadata.requirements,
        },
      });
    }

    await runtime.deleteTask(task.id);
  },
});
```

### Scheduled Reports

```typescript
runtime.registerTaskWorker({
  name: 'GENERATE_WEEKLY_REPORT',
  execute: async (runtime, options, task) => {
    const { roomId } = task;

    // Generate report
    const reportData = await generateWeeklyReport(runtime);

    // Post report
    await runtime.createMemory(
      {
        entityId: runtime.agentId,
        roomId,
        content: {
          text: `# Weekly Report\n\n${reportData}`,
        },
      },
      'messages'
    );

    // Task stays active for next week
  },
});

// Create weekly report task
await runtime.createTask({
  name: 'GENERATE_WEEKLY_REPORT',
  description: 'Weekly activity report',
  roomId: reportChannelId,
  worldId: serverWorldId,
  tags: ['report', 'repeat', 'weekly'],
  metadata: {
    updateInterval: 7 * 86400000, // 7 days
    updatedAt: Date.now(),
    format: 'markdown',
  },
});
```

## Best Practices

1. **Descriptive Names**: Use clear task and worker names
2. **Clean Up**: Delete one-time tasks after execution
3. **Error Handling**: Implement robust error handling
4. **Appropriate Tags**: Use tags for easy retrieval
5. **Validation**: Use validate function for context checks
6. **Atomic Tasks**: Keep tasks focused and simple
7. **Clear Choices**: Make options unambiguous
8. **Lifecycle Management**: Plan task creation/deletion
9. **Reasonable Intervals**: Balance timeliness and resources
10. **Idempotency**: Handle potential concurrent executions

## Integration with Services

Tasks often use services for execution:

```typescript
runtime.registerTaskWorker({
  name: 'CHECK_BLOCKCHAIN',
  execute: async (runtime, options, task) => {
    const solanaService = runtime.getService('solana');
    if (!solanaService) return;

    const balance = await solanaService.getBalance();

    if (balance < task.metadata.threshold) {
      await runtime.createMemory(
        {
          entityId: runtime.agentId,
          roomId: task.roomId,
          content: {
            text: `⚠️ Low balance alert: ${balance} SOL`,
          },
        },
        'messages'
      );
    }
  },
});

# ElizaOS Cypress Frontend Testing

This guide explains how to write and run Cypress tests for ElizaOS frontend components, plugin UIs, and web interfaces using the integrated CLI test runner.

## Overview

ElizaOS supports Cypress for frontend UI testing as part of its comprehensive testing strategy:

- **Unit Tests**: Test individual functions with mocks (Vitest)
- **E2E Runtime Tests**: Test agent behavior with real runtime
- **Cypress Frontend Tests**: Test UI components and user interactions

Cypress tests are automatically detected and run by `elizaos test` when a Cypress configuration file is present.

## Automatic Cypress Detection

The CLI automatically detects Cypress tests by looking for:

- `cypress.config.ts`, `cypress.config.js`, or `cypress.json`
- A `cypress` directory

When detected, Cypress tests run after unit and E2E tests in the test pipeline.

## Test Structure

### Plugin with Frontend UI

```

packages/my-plugin/
├── src/
│ ├── index.ts # Plugin definition with routes
│ └── frontend/ # Frontend code
│ └── index.tsx # UI components
├── cypress/
│ ├── e2e/ # E2E UI tests
│ │ └── plugin-ui.cy.ts
│ ├── support/ # Cypress configuration
│ │ └── e2e.ts
│ └── screenshots/ # Failure screenshots (auto-generated)
├── cypress.config.ts # Cypress configuration
└── package.json # Must include cypress as devDependency

````

## Cypress Configuration

### Basic Configuration

```typescript
// cypress.config.ts
import { defineConfig } from 'cypress';

export default defineConfig({
  e2e: {
    baseUrl: 'http://localhost:3000',
    specPattern: 'cypress/e2e/**/*.cy.{js,jsx,ts,tsx}',
    supportFile: false,
    video: false, // Disable video recording
    screenshotOnRunFailure: true, // Enable screenshots for debugging
    viewportWidth: 1280,
    viewportHeight: 720,
    defaultCommandTimeout: 10000,
    requestTimeout: 10000,
    responseTimeout: 10000,
  },
});
````

## Writing Cypress Tests

### Testing Plugin UI Routes

```typescript
// cypress/e2e/plugin-ui.cy.ts
describe('Plugin UI Tests', () => {
  // Agent ID is provided by the CLI via environment
  const agentId = Cypress.env('AGENT_IDS')?.split(',')[0] || 'test-agent';

  beforeEach(() => {
    // Clear any previous state
    cy.clearAllSessionStorage();
  });

  it('should load the plugin UI successfully', () => {
    // Visit plugin route with agent ID
    cy.visit(`/api/agents/${agentId}/plugins/my-plugin/display`);

    // Verify page loaded without errors
    cy.get('body').should('exist');
    cy.get('body').should('not.contain', '404');
    cy.get('body').should('not.contain', 'Not Found');

    // Verify UI elements
    cy.get('[data-testid="main-heading"]').should('be.visible');
    cy.get('[data-testid="agent-info"]').should('contain', agentId);
  });

  it('should interact with UI elements', () => {
    cy.visit(`/api/agents/${agentId}/plugins/my-plugin/display`);

    // Test button clicks
    cy.get('[data-testid="action-button"]').click();
    cy.get('[data-testid="result"]').should('be.visible');

    // Test form submission
    cy.get('input[name="query"]').type('test query');
    cy.get('form').submit();
    cy.get('[data-testid="results"]').should('contain', 'test query');
  });
});
```

### Testing API Interactions

```typescript
describe('Plugin API Tests', () => {
  const agentId = Cypress.env('AGENT_IDS')?.split(',')[0] || 'test-agent';

  it('should call plugin API endpoints', () => {
    cy.request('GET', `/api/agents/${agentId}/plugins/my-plugin/api/data`).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body).to.have.property('data');
    });
  });

  it('should handle API errors gracefully', () => {
    cy.request({
      url: `/api/agents/${agentId}/plugins/my-plugin/api/invalid`,
      failOnStatusCode: false,
    }).then((response) => {
      expect(response.status).to.eq(404);
    });
  });
});
```

### Testing React Components

For plugins using React:

```typescript
describe('React Component Tests', () => {
  const agentId = Cypress.env('AGENT_IDS')?.split(',')[0];

  it('should render React components correctly', () => {
    cy.visit(`/api/agents/${agentId}/plugins/my-plugin/app`);

    // Wait for React to render
    cy.get('#root').should('exist');

    // Test React-specific behaviors
    cy.get('[data-testid="counter"]').should('contain', '0');
    cy.get('[data-testid="increment"]').click();
    cy.get('[data-testid="counter"]').should('contain', '1');
  });

  it('should handle React hooks and state', () => {
    cy.visit(`/api/agents/${agentId}/plugins/my-plugin/app`);

    // Test async data loading
    cy.intercept('GET', '**/api/data', { fixture: 'mockData.json' });
    cy.get('[data-testid="load-data"]').click();
    cy.get('[data-testid="loading"]').should('be.visible');
    cy.get('[data-testid="data-list"]').should('have.length.greaterThan', 0);
  });
});
```

## Plugin Route Structure

Your plugin must serve UI content via routes:

```typescript
// src/index.ts
import type { Plugin, Route } from '@elizaos/core';

const routes: Route[] = [
  {
    type: 'GET',
    path: '/display',
    handler: async (req, res, runtime) => {
      const html = generateHTML(runtime.agentId);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    },
    name: 'Plugin UI',
    public: true, // Makes it available as a tab
  },
  {
    type: 'GET',
    path: '/api/data',
    handler: async (req, res, runtime) => {
      const data = await fetchData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    },
  },
];

export const MyPlugin: Plugin = {
  name: 'my-plugin',
  routes,
  // ... other plugin properties
};
```

## Running Tests

### Via CLI (Recommended)

```bash
# Run all tests including Cypress
elizaos test

# The CLI will:
# 1. Run unit tests (Vitest)
# 2. Run E2E runtime tests
# 3. Start the server
# 4. Run Cypress tests
# 5. Clean up
```

### Manual Cypress Commands

For development and debugging:

```bash
# Open Cypress Test Runner (interactive mode)
npx cypress open

# Run in headless mode
npx cypress run

# Run specific test
npx cypress run --spec "cypress/e2e/my-test.cy.ts"
```

## Environment Variables

The CLI provides these environment variables to Cypress:

- `CYPRESS_BASE_URL`: The server URL (e.g., http://localhost:3000)
- `CYPRESS_AGENT_IDS`: Comma-separated list of agent IDs

## Error Detection

The CLI detects Cypress failures through:

1. **Exit Codes**: Non-zero exit code indicates failure
2. **Screenshots**: Any screenshots in `cypress/screenshots` indicate failures
3. **Console Output**: Parsed for error messages

## Best Practices

### 1. Use Data Attributes

```html
<!-- In your HTML -->
<button data-testid="submit-button">Submit</button>

<!-- In your tests -->
cy.get('[data-testid="submit-button"]').click();
```

### 2. Handle Async Operations

```typescript
// Wait for API calls
cy.intercept('GET', '**/api/data').as('getData');
cy.visit('/page');
cy.wait('@getData');

// Wait for elements
cy.get('[data-testid="result"]', { timeout: 10000 }).should('be.visible');
```

### 3. Clean State Between Tests

```typescript
beforeEach(() => {
  cy.clearLocalStorage();
  cy.clearCookies();
  cy.clearAllSessionStorage();
});
```

### 4. Test Error States

```typescript
it('should handle errors gracefully', () => {
  // Simulate API error
  cy.intercept('GET', '**/api/data', {
    statusCode: 500,
    body: { error: 'Server error' },
  });

  cy.visit('/page');
  cy.get('[data-testid="error-message"]').should('contain', 'Server error');
});
```

### 5. Avoid Hardcoded Waits

```typescript
// ❌ Bad
cy.wait(2000);

// ✅ Good
cy.get('[data-testid="loaded"]').should('be.visible');
```

## Common Issues

### Port Already in Use

The CLI finds an available port automatically, but if you see port conflicts:

```typescript
// The CLI sets CYPRESS_BASE_URL dynamically
const baseUrl = Cypress.env('BASE_URL') || 'http://localhost:3000';
```

### Agent ID Not Available

Always check for agent ID availability:

```typescript
const agentId = Cypress.env('AGENT_IDS')?.split(',')[0];
if (!agentId) {
  throw new Error('No agent ID provided by test runner');
}
```

### Screenshot Cleanup

The CLI automatically cleans up screenshots before running tests, but you can manually clean:

```bash
rm -rf cypress/screenshots cypress/videos
```

## Integration with CI/CD

The `elizaos test` command is CI-friendly:

```yaml
# GitHub Actions example
- name: Run Tests
  run: |
    bun install
    bun run build
    elizaos test
```

## Plugin Development Workflow

1. **Create Plugin Structure**

   ```bash
   elizaos create plugin my-ui-plugin
   ```

2. **Add Cypress**

   ```bash
   cd packages/my-ui-plugin
   bun add -D cypress
   ```

3. **Create Cypress Config**

   ```bash
   touch cypress.config.ts
   mkdir -p cypress/e2e
   ```

4. **Write Tests**

   ```bash
   touch cypress/e2e/ui.cy.ts
   ```

5. **Run Tests**
   ```bash
   elizaos test
   ```

## Debugging Failed Tests

When tests fail, the CLI provides:

1. **Exit Code**: Non-zero indicates failure
2. **Console Output**: Full Cypress output
3. **Screenshots**: Check `cypress/screenshots/` for failure captures
4. **Error Messages**: Detailed failure reasons

To debug interactively:

```bash
# Open Cypress Test Runner
npx cypress open

# Select the failing test
# Use Chrome DevTools for debugging
```

## Example: Complete Plugin with Tests

See the `plugin-starter` and `plugin-knowledge` packages for complete examples of plugins with Cypress tests:

- Frontend routes serving HTML/React
- API endpoints
- Cypress tests verifying functionality
- Integration with the CLI test runner

Remember: **Cypress tests run automatically when you run `elizaos test` if Cypress is detected in your project.**

## Agent Structure

An Agent is defined by a `Character` object, which is typically stored in a `.json` file or a TypeScript module. This object contains all the information the runtime needs to bring an agent to life.

```typescript
// packages/core/src/types.ts (Simplified)
export interface Character {
  id?: string; // UUID, generated from name if not provided
  name: string;
  description: string;
  // The initial prompt that defines the agent's personality and goals
  systemPrompt: string;
  // Examples of interactions to guide the agent's responses
  messageExamples: Array<Array<{ name: string; content: string }>>;
  // List of plugin packages the agent uses
  plugins: string[];
  // Other configuration...
  [key: string]: unknown;
}
```

## Creating Agents

There are two primary ways to create an agent: as a standalone character file or as part of a project.

### 1. Standalone Character File

Use the `elizaos create` command to generate a new character `.json` file from a template. This is useful for quick tests or for agents that will be loaded dynamically.

```bash
# ✅ DO: Create a new agent character file interactively
elizaos create --type agent

# ✅ DO: Create a character file with a specific name
elizaos create my-new-agent --type agent

# This will create `my-new-agent.json` in the current directory.
```

### 2. Within a Project

When you create a project with `elizaos create --type project`, a template includes an `src/agents/` directory. You should define your agents here as TypeScript modules.

```typescript
// my-project/src/agents/my-agent.ts

import { type Character } from '@elizaos/core';

// ✅ DO: Define the character as a const
export const myAgentCharacter: Character = {
  name: 'My Project Agent',
  description: 'An agent defined within my project.',
  systemPrompt: 'You are a helpful assistant integrated into a project.',
  messageExamples: [
    [
      { name: 'user', content: 'Hello' },
      { name: 'My Project Agent', content: 'Hello! How can I help you today?' },
    ],
  ],
  plugins: ['@elizaos/plugin-sql'], // Plugins are added in the main project file
};
```

This character is then imported and used in the main project entry point (`src/index.ts`).

## Starting Agents

Agents can be started in several ways, depending on the context.

### 1. Starting a Project

When you run `elizaos start` inside a project directory, the CLI loads the agents defined in your `src/index.ts` file and starts them automatically.

```bash
# ✅ DO: Start all agents defined in the current project
cd my-project
elizaos start
```

### 2. Starting a Standalone Character

You can start an agent directly from a character file using either the top-level `start` command or the `agent start` subcommand. This is the primary way to run agents that are not part of a project structure.

```bash
# ✅ DO: Use the top-level start command with the --character flag
# This is useful when the server isn't running yet.
elizaos start --character ./my-agent.json

# ✅ DO: Use the agent subcommand to start a character
# This interacts with an already running server.
elizaos agent start --path ./my-agent.json

# ❌ DON'T: Confuse the two start commands.
# `elizaos start` boots the whole server and project.
# `elizaos agent start` communicates with an already running server.
```

## Managing Live Agents

The `elizaos agent` subcommands allow you to interact with agents on a live, running `AgentServer`. These commands work by making API calls to the server.

### Listing Agents

See all agents currently running on the server.

```bash
# ✅ DO: List all agents
elizaos agent list
# Alias: elizaos agent ls

# ✅ DO: Get the list in JSON format
elizaos agent list --json
```

### Getting Agent Details

Retrieve the full configuration of a specific agent. You can refer to the agent by its name, ID, or index from the `list` command.

```bash
# ✅ DO: Get an agent by name
elizaos agent get --name "My Project Agent"

# ✅ DO: Get an agent by index and save its config to a file
elizaos agent get --name 0 --output my-agent-config.json
```

### Stopping and Removing Agents

You can temporarily stop an agent or remove it permanently.

```bash
# ✅ DO: Stop a running agent by name
elizaos agent stop --name "My Project Agent"

# ✅ DO: Remove an agent permanently
elizaos agent remove --name "My Project Agent"
```

### Updating Agent Configuration

Update a live agent's configuration using a JSON file or a JSON string.

```bash
# ✅ DO: Update an agent from a file
elizaos agent set --name "My Agent" --file ./new-config.json

# ✅ DO: Update an agent using a JSON string
elizaos agent set --name "My Agent" --config '{"description": "A new description"}'
```

This command performs a `PATCH` operation, so you only need to provide the fields you want to change.

## Advanced Patterns

### Dynamic Agent Loading via API

The `elizaos agent start` command demonstrates how to dynamically load agents. It sends a `POST` request to the `/api/agents` endpoint. The body can contain the character JSON directly or a path to a remote character file.

```typescript
// Simplified example of how `agent start --path` works

import fs from 'node:fs';
import path from 'node:path';

async function startAgentFromCli(filePath: string, apiUrl: string) {
  const fullPath = path.resolve(process.cwd(), filePath);
  const fileContent = fs.readFileSync(fullPath, 'utf8');
  const characterJson = JSON.parse(fileContent);

  const payload = {
    characterJson: characterJson,
  };

  const response = await fetch(`${apiUrl}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error('Failed to start agent via API');
  }

  const result = await response.json();
  console.log(`Agent ${result.data.character.name} started.`);
}
```

### Resolving Agent IDs

Many `agent` subcommands require an agent ID. The CLI includes a helper, `resolveAgentId`, that intelligently finds the correct agent ID whether the user provides a name, an ID, or an index.

```typescript
// `resolveAgentId` logic from packages/cli/src/commands/agent.ts

async function resolveAgentId(idOrNameOrIndex: string, opts: any): Promise<string> {
  // 1. Fetch all agents from the server
  const agents = await getAgents(opts);

  // 2. Try to find by name (case-insensitive)
  const byName = agents.find((agent) => agent.name.toLowerCase() === idOrNameOrIndex.toLowerCase());
  if (byName) return byName.id;

  // 3. Try to find by exact ID
  const byId = agents.find((agent) => agent.id === idOrNameOrIndex);
  if (byId) return byId.id;

  // 4. Try to find by index
  const byIndex = agents[Number(idOrNameOrIndex)];
  if (byIndex) return byIndex.id;

  throw new Error(`Agent not found: ${idOrNameOrIndex}`);
}
```

## References

- [Project Management](elizaos_v2_cli_project.mdc)
- [Plugin Integration](elizaos_v2_api_plugins_core.mdc)
- [Core Types (`Character`)](packages/core/src/types.ts)
- [Agent Command Source](packages/cli/src/commands/agent.ts)

## ElizaOS Configuration Architecture

Configuration in ElizaOS is handled through a layered and context-aware system, prioritizing local project settings and secure management of secrets. The system is designed to be both user-friendly for interactive sessions and robust for automated CI/CD environments.

## Configuration Files and Locations

The `UserEnvironment` utility is the brain behind locating configuration files. It intelligently determines the project root, allowing for consistent behavior in both standalone projects and monorepos.

1.  **Project `.env` file** (Primary Configuration):

    - **Location**: At the root of your project directory (e.g., `my-project/.env`). This is found by `UserEnvironment` by searching up from the current directory.
    - **Purpose**: This is the most important configuration file. It stores all secrets, API keys, and environment-specific settings (e.g., `POSTGRES_URL`, `OPENAI_API_KEY`).
    - **Management**: Use the `elizaos env` command for interactive management. For new projects, `elizaos create` will prompt you for initial values and generate this file.
    - **Security**: This file **must never be committed to version control**. Ensure `.env` is in your `.gitignore`.

2.  **Global `config.json`**:
    - **Location**: Inside a global `.eliza` directory in your home directory (e.g., `~/.eliza/config.json`).
    - **Purpose**: Stores non-sensitive, global CLI state. Currently, it's used to track the `lastUpdated` timestamp. It is not intended for user configuration.
    - **Management**: This file is managed automatically by the CLI. You should not need to edit it manually.

## Environment Management (`elizaos env`)

The `elizaos env` command suite is the dedicated tool for managing your local project's `.env` file safely and interactively.

### Listing Environment Variables (`list`)

Get a clear, color-coded overview of your system information and the contents of your local `.env` file. Sensitive values like API keys are automatically masked for security.

```bash
# ✅ DO: List system info and all local .env variables
elizaos env list
```

### Editing Environment Variables (`edit-local`)

This command launches an interactive terminal UI to securely add, edit, or delete variables in your local `.env` file. It's the safest way to manage secrets.

```bash
# ✅ DO: Start the interactive editor for the local .env file
elizaos env edit-local
```

### Resetting the Environment (`reset`)

For a clean slate, the `reset` command can clear configurations and data. It interactively prompts you to select what to reset, including the `.env` file, the cache, and the local PGLite database.

```bash
# ✅ DO: Interactively reset environment, cache, and local DB
elizaos env reset

# ✅ DO: Reset non-interactively, accepting all defaults (useful for CI/CD)
elizaos env reset --yes
```

## Configuration in Practice

### Hierarchy and Precedence

ElizaOS applies configuration in the following order (lower numbers are overridden by higher numbers):

1.  **Built-in Defaults**: Default values hardcoded in the CLI (e.g., server port `3000`, default model names).
2.  **`.env` File**: Variables loaded from your project's local `.env` file via `dotenv`. **This is the standard place for your configuration.**
3.  **Command-Line Flags**: Arguments passed directly to a command (e.g., `elizaos start --port 4000`) will always take the highest precedence, overriding all other sources.

### The `create` Workflow

When you run `elizaos create`, the CLI uses the `env-prompt.ts` utility to guide you.

```typescript
// packages/cli/src/utils/env-prompt.ts

// The CLI has a predefined map of required/optional configs for known plugins.
const ENV_VAR_CONFIGS: Record<string, EnvVarConfig[]> = {
  openai: [ { name: 'OpenAI API Key', key: 'OPENAI_API_KEY', ... } ],
  discord: [ { name: 'Discord API Token', key: 'DISCORD_API_TOKEN', ... } ],
  // ... and so on
};

// It uses this map to interactively prompt the user.
export async function promptForEnvVars(pluginName: string): Promise<void> {
  const envVarConfigs = ENV_VAR_CONFIGS[pluginName.toLowerCase()];
  // ...
  // It then prompts for each required variable...
  const value = await promptForEnvVar(config);
  // ...and writes the result to the .env file.
  await writeEnvFile(envVars);
}
```

### The `start` Workflow

The `elizaos start` command uses `UserEnvironment` to find the correct `.env` file and loads it using `dotenv`. This populates `process.env`, making the variables available to the entire runtime and all plugins.

```typescript
// packages/core/src/runtime.ts

// ✅ DO: Access settings through the runtime's helper method.
// This provides a consistent access pattern.
public getSetting(key: string): string | boolean | null | any {
    const value =
      this.character.secrets?.[key] ||
      this.character.settings?.[key] ||
      this.settings[key]; // this.settings is populated from process.env
    // ... handles decryption ...
    return decryptedValue || null;
}

// In a plugin's init or handler:
const apiKey = runtime.getSetting('OPENAI_API_KEY');
```

## Security Best Practices

- **Secrets belong in `.env`**: Always use your project's local `.env` file for API keys, database URLs, and any other sensitive data.
- **Never Hardcode Secrets**: Do not write secrets directly in your source code (`.ts` files). This is a major security risk.
- **Git Ignore**: Your `.gitignore` file must include `.env` to prevent accidental commits of your secrets. The default project template handles this for you.
- **CI/CD**: For automated environments, do not check in a `.env` file. Instead, use your CI/CD provider's secret management system to inject the required values as environment variables at build/runtime.

## References

- [UserEnvironment Utility](packages/cli/src/utils/user-environment.ts)
- [Environment Prompting Logic](packages/cli/src/utils/env-prompt.ts)
- [Env Command Source](packages/cli/src/commands/env.ts)
- [Agent Management Rules](elizaos_v2_cli_agents.mdc)

# ElizaOS Unit Testing

This guide explains how to write effective unit tests for ElizaOS components using the ElizaOS CLI test runner, which wraps Vitest under the hood.

## Overview

ElizaOS unit tests focus on testing individual components in isolation:

- Test single functions, actions, providers, or services
- Use mocks for all dependencies (especially `IAgentRuntime`)
- Run via `elizaos test` command (wraps Vitest)
- Aim for >75% code coverage on testable components
- Ensure all tests pass before considering work complete

## Key Differences from E2E Tests

| Unit Tests        | E2E Tests         |
| ----------------- | ----------------- |
| Mock the runtime  | Use real runtime  |
| Test in isolation | Test integration  |
| Fast execution    | Slower execution  |
| No side effects   | Real side effects |
| Vitest primitives | Runtime instance  |

## Test Structure

### File Organization

```
packages/my-plugin/
├── src/
│   ├── __tests__/
│   │   ├── actions/
│   │   │   └── my-action.test.ts
│   │   ├── providers/
│   │   │   └── my-provider.test.ts
│   │   ├── services/
│   │   │   └── my-service.test.ts
│   │   └── test-utils.ts         # Shared mock utilities
│   ├── actions/
│   │   └── my-action.ts
│   ├── providers/
│   │   └── my-provider.ts
│   └── index.ts
```

### Basic Test Template

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { myComponent } from '../my-component';
import { createMockRuntime } from '../test-utils';

describe('MyComponent', () => {
  let mockRuntime: any;

  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
    mockRuntime = createMockRuntime();
  });

  it('should handle valid input correctly', async () => {
    // Arrange
    const input = { text: 'valid input' };

    // Act
    const result = await myComponent.process(mockRuntime, input);

    // Assert
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
  });

  it('should handle errors gracefully', async () => {
    // Arrange
    const input = { text: '' };

    // Act & Assert
    await expect(myComponent.process(mockRuntime, input)).rejects.toThrow('Input cannot be empty');
  });
});
```

## Creating Mock Runtime

The most critical part of unit testing is mocking the `IAgentRuntime`. Create a reusable mock factory:

```typescript
// src/__tests__/test-utils.ts
import { vi } from 'vitest';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';

export function createMockRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  return {
    // Core properties
    agentId: 'test-agent-id',
    character: {
      name: 'TestAgent',
      bio: ['Test bio'],
      system: 'Test system prompt',
      messageExamples: [],
      postExamples: [],
      topics: [],
      adjectives: [],
      knowledge: [],
      clients: [],
      plugins: [],
    },

    // Settings
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        API_KEY: 'test-api-key',
        SECRET_KEY: 'test-secret',
        ...overrides.settings,
      };
      return settings[key];
    }),

    // Services
    getService: vi.fn((name: string) => {
      const services: Record<string, any> = {
        'test-service': {
          start: vi.fn(),
          stop: vi.fn(),
          doSomething: vi.fn().mockResolvedValue('service result'),
        },
        ...overrides.services,
      };
      return services[name];
    }),

    // Model/LLM
    useModel: vi.fn().mockResolvedValue('mock model response'),
    generateText: vi.fn().mockResolvedValue('generated text'),

    // Memory operations
    messageManager: {
      createMemory: vi.fn().mockResolvedValue(true),
      getMemories: vi.fn().mockResolvedValue([]),
      updateMemory: vi.fn().mockResolvedValue(true),
      deleteMemory: vi.fn().mockResolvedValue(true),
      searchMemories: vi.fn().mockResolvedValue([]),
      getLastMessages: vi.fn().mockResolvedValue([]),
    },

    // State
    composeState: vi.fn().mockResolvedValue({
      values: {},
      data: {},
      text: '',
    }),
    updateState: vi.fn().mockResolvedValue(true),

    // Actions & Providers
    actions: [],
    providers: [],
    evaluators: [],

    // Components
    createComponent: vi.fn().mockResolvedValue(true),
    getComponents: vi.fn().mockResolvedValue([]),
    updateComponent: vi.fn().mockResolvedValue(true),

    // Database
    db: {
      query: vi.fn().mockResolvedValue([]),
      execute: vi.fn().mockResolvedValue({ changes: 1 }),
      getWorlds: vi.fn().mockResolvedValue([]),
      getWorld: vi.fn().mockResolvedValue(null),
    },

    // Logging
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },

    // Apply any overrides
    ...overrides,
  } as unknown as IAgentRuntime;
}

// Helper to create mock memory objects
export function createMockMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test-memory-id',
    entityId: 'test-entity-id',
    roomId: 'test-room-id',
    agentId: 'test-agent-id',
    content: {
      text: 'test message',
      source: 'test',
    },
    createdAt: Date.now(),
    ...overrides,
  } as Memory;
}

// Helper to create mock state
export function createMockState(overrides: Partial<State> = {}): State {
  return {
    values: {},
    data: {},
    text: '',
    ...overrides,
  } as State;
}
```

## Testing Patterns

### Testing Actions

```typescript
// src/actions/__tests__/my-action.test.ts
import { describe, it, expect, vi } from 'vitest';
import { myAction } from '../my-action';
import { createMockRuntime, createMockMemory, createMockState } from '../../__tests__/test-utils';

describe('MyAction', () => {
  describe('validate', () => {
    it('should return true when all requirements are met', async () => {
      const mockRuntime = createMockRuntime({
        getService: vi.fn().mockReturnValue({ isReady: true }),
      });
      const mockMessage = createMockMemory();

      const isValid = await myAction.validate(mockRuntime, mockMessage);

      expect(isValid).toBe(true);
    });

    it('should return false when service is not available', async () => {
      const mockRuntime = createMockRuntime({
        getService: vi.fn().mockReturnValue(null),
      });
      const mockMessage = createMockMemory();

      const isValid = await myAction.validate(mockRuntime, mockMessage);

      expect(isValid).toBe(false);
    });
  });

  describe('handler', () => {
    it('should process message and return response', async () => {
      const mockRuntime = createMockRuntime();
      const mockMessage = createMockMemory({
        content: { text: 'do something', source: 'test' },
      });
      const mockState = createMockState();
      const mockCallback = vi.fn();

      const result = await myAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback);

      expect(result).toBeDefined();
      expect(result.text).toContain('success');
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.any(String),
          actions: expect.arrayContaining(['MY_ACTION']),
        })
      );
    });

    it('should handle errors gracefully', async () => {
      const mockRuntime = createMockRuntime({
        getService: vi.fn().mockImplementation(() => {
          throw new Error('Service error');
        }),
      });
      const mockMessage = createMockMemory();
      const mockState = createMockState();

      await expect(myAction.handler(mockRuntime, mockMessage, mockState)).rejects.toThrow(
        'Service error'
      );
    });
  });
});
```

### Testing Providers

```typescript
// src/providers/__tests__/my-provider.test.ts
import { describe, it, expect, vi } from 'vitest';
import { myProvider } from '../my-provider';
import { createMockRuntime, createMockMemory, createMockState } from '../../__tests__/test-utils';

describe('MyProvider', () => {
  it('should provide context information', async () => {
    const mockRuntime = createMockRuntime({
      getSetting: vi.fn().mockReturnValue('test-value'),
    });
    const mockMessage = createMockMemory();
    const mockState = createMockState();

    const result = await myProvider.get(mockRuntime, mockMessage, mockState);

    expect(result).toBeDefined();
    expect(result.text).toContain('Provider context');
    expect(result.values).toHaveProperty('setting', 'test-value');
  });

  it('should handle missing configuration', async () => {
    const mockRuntime = createMockRuntime({
      getSetting: vi.fn().mockReturnValue(null),
    });
    const mockMessage = createMockMemory();
    const mockState = createMockState();

    const result = await myProvider.get(mockRuntime, mockMessage, mockState);

    expect(result.text).toContain('not configured');
  });
});
```

### Testing Services

```typescript
// src/services/__tests__/my-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MyService } from '../my-service';
import { createMockRuntime } from '../../__tests__/test-utils';

describe('MyService', () => {
  let service: MyService;
  let mockRuntime: any;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    service = new MyService(mockRuntime);
  });

  describe('start', () => {
    it('should initialize successfully', async () => {
      await service.start();

      expect(service.isReady()).toBe(true);
      expect(mockRuntime.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Service started')
      );
    });

    it('should handle initialization errors', async () => {
      mockRuntime.getSetting.mockReturnValue(null);

      await expect(service.start()).rejects.toThrow('Missing configuration');
    });
  });

  describe('operations', () => {
    beforeEach(async () => {
      await service.start();
    });

    it('should perform operation successfully', async () => {
      const result = await service.performOperation('test-input');

      expect(result).toBe('expected-output');
      expect(mockRuntime.logger.debug).toHaveBeenCalled();
    });

    it('should validate input before processing', async () => {
      await expect(service.performOperation('')).rejects.toThrow('Invalid input');
    });
  });

  describe('stop', () => {
    it('should clean up resources', async () => {
      await service.start();
      await service.stop();

      expect(service.isReady()).toBe(false);
      expect(mockRuntime.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Service stopped')
      );
    });
  });
});
```

### Testing Utility Functions

```typescript
// src/utils/__tests__/helpers.test.ts
import { describe, it, expect } from 'vitest';
import { formatMessage, validateInput, parseResponse } from '../helpers';

describe('Utility Functions', () => {
  describe('formatMessage', () => {
    it('should format message correctly', () => {
      const input = { text: 'hello', user: 'test' };
      const result = formatMessage(input);

      expect(result).toBe('[test]: hello');
    });

    it('should handle empty text', () => {
      const input = { text: '', user: 'test' };
      const result = formatMessage(input);

      expect(result).toBe('[test]: <empty message>');
    });
  });

  describe('validateInput', () => {
    it('should accept valid input', () => {
      expect(validateInput('valid input')).toBe(true);
    });

    it('should reject invalid input', () => {
      expect(validateInput('')).toBe(false);
      expect(validateInput(null)).toBe(false);
      expect(validateInput(undefined)).toBe(false);
    });
  });
});
```

## Running Tests

### Commands

```bash
# Run all tests (unit and E2E)
elizaos test

# Run tests from package.json script
npm test

# Run tests with coverage
npm run test:coverage
```

### Coverage Requirements

Aim for >75% coverage on testable code:

- Actions: Test both `validate` and `handler`
- Providers: Test the `get` method
- Services: Test lifecycle and public methods
- Utilities: Test all exported functions

## Best Practices

1. **Isolation**: Each test should be completely independent
2. **Clear Structure**: Use Arrange-Act-Assert pattern
3. **Mock Everything**: Never use real services, databases, or APIs
4. **Test Edge Cases**: Empty inputs, null values, errors
5. **Descriptive Names**: Test names should explain what they verify
6. **Fast Execution**: Unit tests should run in milliseconds
7. **Coverage Goals**: Maintain >75% coverage on testable code
8. **Pass Before Proceeding**: All tests must pass before moving on

## Common Patterns

### Mocking Async Operations

```typescript
// Mock a service that returns promises
const mockService = {
  fetchData: vi.fn().mockResolvedValue({ data: 'test' }),
  saveData: vi.fn().mockResolvedValue(true),
  // Simulate errors
  failingMethod: vi.fn().mockRejectedValue(new Error('API Error')),
};
```

### Testing Error Scenarios

```typescript
it('should handle network errors', async () => {
  const mockRuntime = createMockRuntime({
    useModel: vi.fn().mockRejectedValue(new Error('Network error')),
  });

  await expect(myAction.handler(mockRuntime, message, state)).rejects.toThrow('Network error');
});
```

### Spying on Method Calls

```typescript
it('should call logger with correct parameters', async () => {
  const mockRuntime = createMockRuntime();

  await myComponent.process(mockRuntime, input);

  expect(mockRuntime.logger.info).toHaveBeenCalledWith('Processing started', { input });
  expect(mockRuntime.logger.info).toHaveBeenCalledTimes(2);
});
```

### Testing with Different Runtime Configurations

```typescript
const testCases = [
  { setting: 'MODE', value: 'production', expected: 'strict' },
  { setting: 'MODE', value: 'development', expected: 'relaxed' },
];

testCases.forEach(({ setting, value, expected }) => {
  it(`should handle ${value} mode correctly`, async () => {
    const mockRuntime = createMockRuntime({
      getSetting: vi.fn((key) => (key === setting ? value : null)),
    });

    const result = await myComponent.getMode(mockRuntime);
    expect(result).toBe(expected);
  });
});
```

## Debugging Tests

### Useful Vitest Features

```typescript
// Skip a test temporarily
it.skip('should do something', async () => {
  // Test implementation
});

// Run only this test
it.only('should focus on this', async () => {
  // Test implementation
});

// Add console logs for debugging
it('should debug something', async () => {
  console.log('Input:', input);
  const result = await myComponent.process(input);
  console.log('Result:', result);
  expect(result).toBeDefined();
});
```

Remember:

- **Always use `elizaos test`**, not direct vitest commands
- **Mock everything** - no real dependencies in unit tests
- **Aim for >75% coverage** on testable code
- **All tests must pass** before considering work complete

## LLM Provider Architecture

In ElizaOS, LLMs are integrated via plugins that register `ModelHandler` functions with the `AgentRuntime`. This allows the agent to use different models for various tasks like text generation, reasoning, and creating embeddings. The runtime manages a prioritized list of handlers for each `ModelType`.

## Core Concepts

### `ModelType` Enum

This enum in `@elizaos/core` defines the standard categories of models the runtime understands. Plugins should register handlers for one or more of these types.

```typescript
// packages/core/src/types.ts (partial)
export const ModelType = {
  TEXT_SMALL: 'TEXT_SMALL',
  TEXT_LARGE: 'TEXT_LARGE',
  TEXT_EMBEDDING: 'TEXT_EMBEDDING',
  TEXT_REASONING_LARGE: 'REASONING_LARGE',
  // ... and others for images, audio, etc.
} as const;
```

### `ModelHandler` Interface

A `ModelHandler` is an object that packages the model-calling function with its metadata.

```typescript
// packages/core/src/types.ts (partial)
export interface ModelHandler {
  handler: (runtime: IAgentRuntime, params: Record<string, unknown>) => Promise<unknown>;
  provider: string; // The name of the plugin providing this handler
  priority?: number; // Higher number means higher priority
  registrationOrder?: number; // Internal tie-breaker
}
```

### Registration and Selection

- **`runtime.registerModel(type, handler, provider, priority)`**: A plugin calls this in its `init` function to make a model available.
- **`runtime.getModel(type)`**: The runtime uses this internally to retrieve the highest-priority handler for a given `ModelType`. If multiple handlers have the same priority, the one registered first is chosen.
- **`runtime.useModel(type, params)`**: This is the primary method agents and other components use to invoke a model. It automatically selects the best available handler and executes it.

## Implementation Pattern

Here is how you would create a plugin that provides an LLM for text generation.

### 1. Define the Model Handler

Create a function that takes the runtime and parameters, calls the external LLM API, and returns the result in the expected format.

```typescript
// my-llm-plugin/src/handler.ts
import { type IAgentRuntime, type TextGenerationParams } from '@elizaos/core';
import { callMyLlmApi } from './api'; // Your API client

// ✅ DO: Implement the handler function matching the expected parameters
export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: TextGenerationParams
): Promise<string> {
  const apiKey = runtime.getSetting('MY_LLM_API_KEY');
  if (!apiKey) {
    throw new Error('MY_LLM_API_KEY is not configured.');
  }

  const { prompt, temperature, maxTokens } = params;

  // ✅ DO: Call your external API and format the parameters correctly
  const response = await callMyLlmApi(apiKey, {
    prompt,
    temperature,
    max_tokens: maxTokens,
  });

  // ✅ DO: Return the result in the format expected by ModelResultMap
  // For TEXT_LARGE, this is a string.
  return response.choices[0].text;
}
```

### 2. Create the Plugin

In your plugin's main file, register the handler.

```typescript
// my-llm-plugin/src/index.ts
import { type Plugin, ModelType } from '@elizaos/core';
import { handleTextLarge } from './handler';

export const myLlmProviderPlugin: Plugin = {
  name: 'my-llm-provider',
  description: 'Provides access to My Custom LLM.',

  // ✅ DO: Register your model handlers in the `models` property
  models: {
    // The key must match a value from the ModelType enum
    [ModelType.TEXT_LARGE]: handleTextLarge,
  },

  // Set a priority if you want this model to be preferred over others
  priority: 10,

  async init(config, runtime) {
    // You can perform validation here
    const apiKey = runtime.getSetting('MY_LLM_API_KEY');
    if (!apiKey) {
      runtime.logger.warn(`${this.name} requires an API key. It may not function correctly.`);
    }
  },
};
```

### 3. Usage in an Action or Provider

Once the plugin is registered, any other component can use the model via `runtime.useModel`.

```typescript
// another-plugin/src/actions.ts
import { type Action, type IAgentRuntime, ModelType } from '@elizaos/core';

export const myAction: Action = {
  name: 'ask-my-llm',
  // ...
  async handler(runtime: IAgentRuntime, message) {
    const question = message.content.text;

    // ✅ DO: Use `runtime.useModel` to invoke the model
    // The runtime handles selecting the highest-priority provider.
    const responseText = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: `The user asked: ${question}. Please provide a concise answer.`,
      temperature: 0.5,
    });

    // ... do something with the response
    return { text: responseText };
  },
  // ...
};
```

## Best Practices

### Parameter and Result Typing

- Use the generic parameter and result types from `@elizaos/core` (`ModelParamsMap`, `ModelResultMap`, `TextGenerationParams`, etc.) to ensure your handler is compatible with the runtime.
- If your model returns extra metadata (like token usage), you can attach it to the response, but ensure the primary return value matches the `ModelResultMap` type for the given `ModelType`.

### Error Handling

- Your handler function should perform robust error handling. If an API call fails, throw a descriptive error. The `useModel` call will propagate this error, allowing the caller to handle it.
- Check for required API keys or configuration in your plugin's `init` function and log a warning if they are missing.

### Priority

- If you are creating a plugin that you intend to be the default for a certain `ModelType`, give it a `priority`. For example, `@elizaos/plugin-openai` might have a higher priority than a local model provider.
- If no priority is set, it defaults to `0`. The registration order is used as a tie-breaker.

### Providing Multiple Models

A single plugin can provide handlers for multiple `ModelType`s.

```typescript
// my-full-llm-plugin/src/index.ts
import { type Plugin, ModelType } from '@elizaos/core';
import { handleTextLarge, handleEmbedding } from './handlers';

export const myFullLlmPlugin: Plugin = {
  name: 'my-full-llm-provider',
  description: 'Provides text and embedding models.',

  models: {
    [ModelType.TEXT_LARGE]: handleTextLarge,
    [ModelType.TEXT_EMBEDDING]: handleEmbedding,
  },
};
```

## References

- [Core Types (`ModelType`, `ModelHandler`, `ModelParamsMap`)](packages/core/src/types.ts)
- [Agent Runtime (`registerModel`, `useModel`)](packages/core/src/runtime.ts)
- [Example: OpenAI Plugin](packages/plugin-openai/src/index.ts)

# ElizaOS Evaluators System

Evaluators are cognitive components that enable agents to process conversations, extract knowledge, and build understanding by reflecting on the action chain. They run after the actions are processed, and are there to guaranteeably run after everything else runs. A good use of an evaluator is to determine and extract new facts about someone we're talking to. It's very similar to an action, but doesn't chain, and always runs without being selected. Evaluators can enable agents to perform background analysis after responses are generated, similar to how humans form memories after interactions. This is very similar to the concept of reflection from the "Reflexion" paper.

## Core Concepts

### Evaluator Structure

```typescript
interface Evaluator {
  name: string; // Unique identifier
  similes?: string[]; // Alternative names
  description: string; // Purpose explanation
  examples: EvaluationExample[]; // Sample patterns
  handler: Handler; // Implementation logic
  validate: Validator; // Execution criteria
  alwaysRun?: boolean; // Run regardless of validation
}
```

### Execution Flow

1. Agent processes message and generates response
2. Runtime calls `evaluate()` after response
3. Each evaluator's `validate()` checks if it should run
4. Valid evaluators execute via `handler()`
5. Results stored in memory for future use

## Key Evaluators

### Fact Evaluator

Extracts and stores factual information from conversations:

```typescript
const factEvaluator: Evaluator = {
  name: 'EXTRACT_FACTS',

  validate: async (runtime, message) => {
    // Run periodically, not every message
    const messageCount = await runtime.countMemories(message.roomId);
    const interval = Math.ceil(runtime.getConversationLength() / 2);
    return messageCount % interval === 0;
  },

  handler: async (runtime, message, state) => {
    // Extract facts using LLM
    const facts = await extractFacts(state);

    // Filter and deduplicate
    const newFacts = facts.filter(
      (fact) => !fact.already_known && fact.type === 'fact' && fact.claim?.trim()
    );

    // Store as embeddings
    for (const fact of newFacts) {
      await runtime.addEmbeddingToMemory({
        content: { text: fact.claim },
        entityId: message.entityId,
        roomId: message.roomId,
      });
    }
  },
};
```

### Reflection Evaluator

Enables self-awareness and relationship tracking:

```typescript
const reflectionEvaluator: Evaluator = {
  name: 'REFLECT',

  handler: async (runtime, message, state) => {
    const reflection = await generateReflection(state);

    // Extract components
    const { thought, facts, relationships } = reflection;

    // Store self-reflection
    if (thought) {
      await runtime.createMemory({
        content: { text: thought, type: 'reflection' },
        entityId: runtime.agentId,
        roomId: message.roomId,
      });
    }

    // Create relationships
    for (const rel of relationships) {
      await runtime.createRelationship({
        sourceEntityId: rel.sourceEntityId,
        targetEntityId: rel.targetEntityId,
        tags: rel.tags,
      });
    }
  },
};
```

## Memory Formation Patterns

### Episodic vs Semantic

- **Episodic**: Raw conversation history (specific experiences)
- **Semantic**: Extracted facts and knowledge (general understanding)
- Facts build semantic memory from episodic experiences

### Progressive Learning

```typescript
// First encounter
"I work at TechCorp" → Store: {entity: "user", employer: "TechCorp"}

// Later conversation
"I'm a senior engineer at TechCorp" → Update: {role: "senior engineer"}

// Builds complete picture over time
```

### Relationship Evolution

```typescript
// Initial interaction
{ tags: ["new_interaction"] }

// After multiple conversations
{
  tags: ["frequent_interaction", "positive_sentiment"],
  metadata: { interactions: 15, trust_level: "high" }
}
```

## Implementation Patterns

### Custom Evaluator

```typescript
const customEvaluator: Evaluator = {
  name: 'CUSTOM_ANALYSIS',
  description: 'Analyzes specific patterns',

  validate: async (runtime, message, state) => {
    // Check if evaluation needed
    return message.content.text?.includes('analyze');
  },

  handler: async (runtime, message, state) => {
    // Perform analysis
    const analysis = await analyzePattern(state);

    // Store results
    await runtime.addEmbeddingToMemory({
      entityId: runtime.agentId,
      content: {
        text: `Analysis: ${analysis.summary}`,
        metadata: analysis,
      },
      roomId: message.roomId,
    });

    return { success: true };
  },

  examples: [
    {
      prompt: 'Conversation with analysis request',
      messages: [
        { name: 'User', content: { text: 'Can you analyze this data?' } },
        { name: 'Agent', content: { text: "I'll analyze that for you." } },
      ],
      outcome: 'Analysis stored in memory',
    },
  ],
};
```

## Best Practices

1. **Validation Efficiency**: Keep validation checks lightweight
2. **Periodic Execution**: Don't run on every message
3. **Fact Verification**: Cross-reference with existing knowledge
4. **Memory Management**: Prioritize important information
5. **Privacy Respect**: Filter sensitive information
6. **Error Handling**: Continue gracefully on failures

## Integration with System

### With Actions

- Actions create responses → Evaluators analyze them
- Evaluators store insights → Actions use in future

### With Providers

- Providers supply context → Evaluators process it
- Evaluators create facts → Fact provider serves them

### With Memory

- Evaluators create embeddings for semantic search
- Facts enhance future context retrieval
- Relationships improve entity resolution

## Common Evaluator Types

- **FACT_EXTRACTOR**: Extracts factual claims
- **REFLECTION**: Self-assessment and improvement
- **GOAL_TRACKER**: Monitors conversation objectives
- **TRUST_EVALUATOR**: Assesses interaction quality
- **TOPIC_ANALYZER**: Identifies conversation themes
- **SENTIMENT_ANALYZER**: Tracks emotional context

## Plugin Registration

```typescript
const myPlugin: Plugin = {
  name: 'my-plugin',
  evaluators: [factEvaluator, reflectionEvaluator, customEvaluator],

  init: async (runtime) => {
    // Evaluators automatically registered
  },
};
```

# ElizaOS Providers System

Providers are the sources of information for agents. They act as the agent's "senses", injecting real-time information and context into the agent's decision-making process.

## Core Concepts

### Provider Structure

```typescript
interface Provider {
  name: string; // Unique identifier
  description?: string; // Purpose explanation
  dynamic?: boolean; // Only used when explicitly requested
  position?: number; // Execution order (lower runs first)
  private?: boolean; // Must be explicitly included
  get: (runtime: IAgentRuntime, message: Memory, state: State) => Promise<ProviderResult>;
}

interface ProviderResult {
  values?: { [key: string]: any }; // Merged into state.values
  data?: { [key: string]: any }; // Stored in state.data.providers
  text?: string; // Injected into agent context
}
```

## Provider Types

### Regular Providers

- Automatically included in context composition
- Run for every message unless filtered out
- Example: TIME, CHARACTER, RECENT_MESSAGES

### Dynamic Providers

- Only included when explicitly requested
- Used for expensive or situational data
- Example: WEATHER, PORTFOLIO

### Private Providers

- Never included automatically
- Must be explicitly included via `includeList`
- Example: INTERNAL_METRICS

## State Composition

```typescript
// Default: all regular providers
const state = await runtime.composeState(message);

// Filtered: only specific providers
const state = await runtime.composeState(
  message,
  ['TIME', 'FACTS'] // Only these providers
);

// Include private/dynamic providers
const state = await runtime.composeState(
  message,
  null,
  ['WEATHER', 'PRIVATE_DATA'] // Include these extras
);
```

## Implementation Patterns

### Basic Provider

```typescript
const timeProvider: Provider = {
  name: 'TIME',
  description: 'Provides current date and time',
  position: -10, // Run early

  get: async (runtime, message) => {
    const now = new Date();
    const formatted = now.toLocaleString('en-US', {
      timeZone: 'UTC',
      dateStyle: 'full',
      timeStyle: 'long',
    });

    return {
      text: `Current time: ${formatted}`,
      values: {
        currentDate: now.toISOString(),
        humanDate: formatted,
      },
    };
  },
};
```

### Dynamic Provider

```typescript
const weatherProvider: Provider = {
  name: 'WEATHER',
  dynamic: true, // Only when requested

  get: async (runtime, message, state) => {
    const location = state.values.location || 'San Francisco';
    const weather = await fetchWeatherAPI(location);

    return {
      text: `Weather in ${location}: ${weather.description}`,
      values: {
        weather: {
          location,
          temperature: weather.temp,
          conditions: weather.description,
        },
      },
      data: {
        fullWeatherData: weather, // Additional data
      },
    };
  },
};
```

### Action State Provider

Special provider for action chaining that exposes:

- Previous action results
- Working memory state
- Active plan information

```typescript
const actionStateProvider: Provider = {
  name: 'ACTION_STATE',
  position: -5, // High priority

  get: async (runtime, message, state) => {
    const actionResults = state.data?.actionResults || [];
    const workingMemory = runtime.getWorkingMemory(message.roomId);

    return {
      text: formatActionResults(actionResults),
      values: {
        previousActionCount: actionResults.length,
        lastActionSuccess: actionResults.slice(-1)[0]?.success,
      },
      data: {
        actionResults,
        workingMemory: workingMemory?.serialize(),
      },
    };
  },
};
```

## Common Provider Categories

### System & Integration

- **TIME**: Current date/time
- **CHARACTER**: Agent personality
- **RECENT_MESSAGES**: Conversation history
- **ACTION_STATE**: Action execution state
- **ENTITIES**: User information

### External Services

- **WEATHER**: Weather data
- **NEWS**: Current events
- **MARKET**: Financial data
- **SOCIAL**: Social media info

### Knowledge & Context

- **FACTS**: Extracted knowledge
- **TOPICS**: Conversation topics
- **SETTINGS**: Configuration values
- **CAPABILITIES**: Agent abilities

## Best Practices

1. **Return Structure**: Always return `ProviderResult` with appropriate fields
2. **Error Handling**: Handle errors gracefully, return empty result on failure
3. **Caching**: Use runtime cache for expensive operations
4. **Position**: Set appropriate position for execution order
5. **Dynamic Flag**: Mark expensive providers as dynamic
6. **Text Formatting**: Format text for clear context injection

## Provider Flow

1. `composeState()` called with message
2. Providers filtered based on type and request
3. Providers execute in position order
4. Results cached and aggregated
5. State object returned with merged data

## Integration with Actions

Providers run before action selection, providing context that helps the LLM choose appropriate actions. The ACTION_STATE provider specifically enables action chaining by exposing previous execution results.
