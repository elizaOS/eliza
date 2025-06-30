# ElizaOS Advanced Migration Guide - v1.x

> **Important**: This guide covers advanced breaking changes for evaluators, services, and runtime methods. Read the main [migration-guide.md](./migration-guide.md) first for actions, providers, and basic migrations.

## Table of Contents

- [Evaluators Migration](#evaluators-migration)
- [Services & Clients Migration](#services--clients-migration)
- [Runtime Method Changes](#runtime-method-changes)
- [Entity System Migration](#entity-system-migration)

---

## Evaluators Migration

### Evaluator Interface Changes

Evaluators remain largely unchanged in their core structure, but their integration with the runtime has evolved:

```typescript
// v0 Evaluator usage remains the same
export interface Evaluator {
  alwaysRun?: boolean;
  description: string;
  similes: string[];
  examples: EvaluationExample[];
  handler: Handler;
  name: string;
  validate: Validator;
}
```

### Key Changes:

1. **Evaluation Results**: The `evaluate()` method now returns `Evaluator[]` instead of `string[]`:

```typescript
// v0: Returns string array of evaluator names
const evaluators: string[] = await runtime.evaluate(message, state);

// v1: Returns Evaluator objects
const evaluators: Evaluator[] | null = await runtime.evaluate(message, state);
```

2. **Additional Parameters**: The evaluate method accepts new optional parameters:

```typescript
// v1: Extended evaluate signature
await runtime.evaluate(
    message: Memory,
    state?: State,
    didRespond?: boolean,
    callback?: HandlerCallback,
    responses?: Memory[]  // NEW: Can pass responses for evaluation
);
```

---

## Services & Clients Migration

### Service Registration Changes

Services have undergone significant architectural changes:

```typescript
// v0: Service extends abstract Service class
export abstract class Service {
  static get serviceType(): ServiceType {
    throw new Error('Service must implement static serviceType getter');
  }

  public static getInstance<T extends Service>(): T {
    // Singleton pattern
  }

  abstract initialize(runtime: IAgentRuntime): Promise<void>;
}

// v1: Service is now a class with static properties
export class Service {
  static serviceType: ServiceTypeName;

  async initialize(runtime: IAgentRuntime): Promise<void> {
    // Implementation
  }
}
```

### Migration Steps:

1. **Remove Singleton Pattern**:

```typescript
// v0: Singleton getInstance
class MyService extends Service {
  private static instance: MyService | null = null;

  public static getInstance(): MyService {
    if (!this.instance) {
      this.instance = new MyService();
    }
    return this.instance;
  }
}

// v1: Direct instantiation
class MyService extends Service {
  static serviceType = ServiceTypeName.MY_SERVICE;
  // No getInstance needed
}
```

2. **Update Service Registration**:

```typescript
// v0: Register instance
await runtime.registerService(MyService.getInstance());

// v1: Register class
await runtime.registerService(MyService);
```

3. **Service Type Enum Changes**:

```typescript
// v0: ServiceType enum
export enum ServiceType {
  IMAGE_DESCRIPTION = 'image_description',
  TRANSCRIPTION = 'transcription',
  // ...
}

// v1: ServiceTypeName (similar but may have new values)
export enum ServiceTypeName {
  IMAGE_DESCRIPTION = 'image_description',
  TRANSCRIPTION = 'transcription',
  // Check for any renamed or new service types
}
```

---

## Runtime Method Changes

### 1. State Management

The `updateRecentMessageState` method has been removed:

```typescript
// v0: Separate method for updating state
currentState = await runtime.updateRecentMessageState(currentState);

// v1: Use composeState with specific keys
currentState = await runtime.composeState(message, ['RECENT_MESSAGES']);
```

### 2. Memory Manager Access

Memory managers are no longer directly accessible:

```typescript
// v0: Direct access to memory managers
runtime.messageManager.getMemories({...});
runtime.registerMemoryManager(manager);
const manager = runtime.getMemoryManager("messages");

// v1: Use database adapter methods
await runtime.getMemories({
    roomId,
    count,
    unique: false,
    tableName: "messages",
    agentId: runtime.agentId
});
```

### 3. Model Usage

Complete overhaul of model interaction:

```typescript
// v0: generateText with ModelClass
import { generateText, ModelClass } from '@elizaos/core';

const result = await generateText({
  runtime,
  context: prompt,
  modelClass: ModelClass.SMALL,
});

// v1: useModel with ModelTypeName
const result = await runtime.useModel(ModelTypeName.TEXT_SMALL, {
  prompt,
  stopSequences: [],
});
```

### 4. Settings Management

#### Global Settings Object Removed

The global `settings` object is no longer exported from `@elizaos/core`:

```typescript
// v0: Import and use global settings
import { settings } from '@elizaos/core';

const charityAddress = settings[networkKey];
const apiKey = settings.OPENAI_API_KEY;

// v1: Use runtime.getSetting()
// Remove the settings import
import { elizaLogger, type IAgentRuntime } from '@elizaos/core';

const charityAddress = runtime.getSetting(networkKey);
const apiKey = runtime.getSetting('OPENAI_API_KEY');
```

#### New Settings Methods

```typescript
// v0: Only getSetting through runtime
const value = runtime.getSetting(key);

// v1: Both get and set
const value = runtime.getSetting(key);
runtime.setSetting(key, value, isSecret);
```

#### Migration Example

```typescript
// v0: utils.ts using global settings
import { settings } from '@elizaos/core';

export function getCharityAddress(network: string): string | null {
  const networkKey = `CHARITY_ADDRESS_${network.toUpperCase()}`;
  const charityAddress = settings[networkKey];
  return charityAddress;
}

// v1: Pass runtime to access settings
export function getCharityAddress(runtime: IAgentRuntime, network: string): string | null {
  const networkKey = `CHARITY_ADDRESS_${network.toUpperCase()}`;
  const charityAddress = runtime.getSetting(networkKey);
  return charityAddress;
}
```

#### Common Settings Migration Patterns

1. **Environment Variables**: Both v0 and v1 read from environment variables, but access patterns differ
2. **Dynamic Settings**: v1 allows runtime setting updates with `setSetting()`
3. **Secret Management**: v1 adds explicit secret handling with the `isSecret` parameter

#### Real-World Fix: Coinbase Plugin

The Coinbase plugin's `getCharityAddress` function needs updating:

```typescript
// v0: Current broken code
import { settings } from '@elizaos/core'; // ERROR: 'settings' not exported

export function getCharityAddress(network: string, isCharitable = false): string | null {
  const networkKey = `CHARITY_ADDRESS_${network.toUpperCase()}`;
  const charityAddress = settings[networkKey]; // ERROR: Cannot use settings
  // ...
}

// v1: Fixed code - runtime parameter added
export function getCharityAddress(
  runtime: IAgentRuntime, // Add runtime parameter
  network: string,
  isCharitable = false
): string | null {
  const networkKey = `CHARITY_ADDRESS_${network.toUpperCase()}`;
  const charityAddress = runtime.getSetting(networkKey); // Use runtime.getSetting
  // ...
}

// Update all callers to pass runtime
const charityAddress = getCharityAddress(runtime, network);
```

### 5. Event System

New event-driven architecture:

```typescript
// v1: Register and emit events
runtime.registerEvent('custom-event', async (params) => {
  // Handle event
});

await runtime.emitEvent('custom-event', { data: 'value' });
```

---

## Entity System Migration

The most significant change is the shift from User/Participant to Entity/Room/World:

### User → Entity

```typescript
// v0: User-based methods
await runtime.ensureUserExists(userId, userName, name, email, source);
const account = await runtime.getAccountById(userId);

// v1: Entity-based methods
await runtime.ensureConnection({
  entityId: userId,
  roomId,
  userName,
  name,
  worldId,
  source,
});
const entity = await runtime.getEntityById(entityId);
```

### Participant → Room Membership

```typescript
// v0: Participant methods
await runtime.ensureParticipantExists(userId, roomId);
await runtime.ensureParticipantInRoom(userId, roomId);

// v1: Simplified room membership
await runtime.ensureParticipantInRoom(entityId, roomId);
```

### New World Concept

v1 introduces the concept of "worlds" (servers/environments):

```typescript
// v1: World management
await runtime.ensureWorldExists({
  id: worldId,
  name: serverName,
  type: 'discord', // or other platform
});

// Get all rooms in a world
const rooms = await runtime.getRooms(worldId);
```

### Connection Management

```typescript
// v0: Multiple ensure methods
await runtime.ensureUserExists(...);
await runtime.ensureRoomExists(roomId);
await runtime.ensureParticipantInRoom(...);

// v1: Single connection method
await runtime.ensureConnection({
    entityId,
    roomId,
    worldId,
    userName,
    name,
    source,
    channelId,
    serverId,
    type: 'user',
    metadata: {}
});
```

---

## Client Migration

Clients now have a simpler interface:

```typescript
// v0: Client with config
export type Client = {
  name: string;
  config?: { [key: string]: any };
  start: (runtime: IAgentRuntime) => Promise<ClientInstance>;
};

// v1: Client integrated with services
// Clients are now typically implemented as services
class MyClient extends Service {
  static serviceType = ServiceTypeName.MY_CLIENT;

  async initialize(runtime: IAgentRuntime): Promise<void> {
    // Start client operations
  }

  async stop(): Promise<void> {
    // Stop client operations
  }
}
```

---

## Quick Reference

### Removed Methods

- `updateRecentMessageState()` → Use `composeState(message, ['RECENT_MESSAGES'])`
- `registerMemoryManager()` → Not needed, use database adapter
- `getMemoryManager()` → Use database adapter methods
- `registerContextProvider()` → Use `registerProvider()`

### Removed Exports

- `settings` object → Use `runtime.getSetting(key)` instead

### Changed Methods

- `evaluate()` → Now returns `Evaluator[]` instead of `string[]`
- `getAccountById()` → `getEntityById()`
- `ensureUserExists()` → `ensureConnection()`
- `generateText()` → `runtime.useModel()`

### New Methods

- `setSetting()`
- `registerEvent()`
- `emitEvent()`
- `useModel()`
- `registerModel()`
- `ensureWorldExists()`
- `getRooms()`

---

## Migration Checklist

- [ ] Update all evaluator result handling to expect `Evaluator[]` objects
- [ ] Remove singleton patterns from services
- [ ] Update service registration to pass classes instead of instances
- [ ] Replace `updateRecentMessageState` with `composeState`
- [ ] Migrate from `generateText` to `runtime.useModel`
- [ ] Update user/participant methods to entity/room methods
- [ ] Add world management for multi-server environments
- [ ] Convert clients to service-based architecture
- [ ] Update any direct memory manager access to use database adapter
- [ ] Replace `import { settings }` with `runtime.getSetting()` calls
- [ ] Update functions to accept `runtime` parameter where settings are needed

---

## Need Help?

If you encounter issues not covered in this guide:

1. Check the main [migration-guide.md](./migration-guide.md) for basic migrations
2. Review the [v1.x examples](../packages/core/examples) for reference implementations
3. Join our Discord community for support
