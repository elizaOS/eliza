---
sidebar_position: 7
title: World System
description: Understanding ElizaOS worlds - virtual spaces for agent interactions and communication
keywords: [worlds, environments, spaces, rooms, entities, roles, permissions, events]
image: /img/elizaos-worlds-cosmic-clean.svg
---

# Worlds

Worlds in ElizaOS are collections of entities (users, agents) and rooms (conversations, channels) that form a cohesive environment for interactions. Think of a world as a virtual space, like a Discord server, Slack workspace, or 3D MMO environment, where entities can communicate across multiple channels or areas.

![](/img/elizaos-worlds-cosmic-clean.svg)

Within each world you can have rooms, which are akin to individual threads or channels in a server.

![](/img/elizaos-worlds-simplified.svg)

## World Structure

A world in ElizaOS has the following properties:

```typescript
type World = {
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

| Property   | Description                                          | Required |
| ---------- | ---------------------------------------------------- | -------- |
| `id`       | Unique identifier for the world                      | Yes      |
| `name`     | Optional display name                                | No       |
| `agentId`  | ID of the agent managing this world                  | Yes      |
| `serverId` | External system identifier (e.g., Discord server ID) | Yes      |
| `metadata` | Additional world configuration data                  | No       |

The metadata can store custom information, including ownership details and role assignments for entities within the world.

## World Creation and Management

### Creating a World

You can create a new world using the AgentRuntime:

```typescript
const worldId = await runtime.createWorld({
  id: customWorldId, // Optional - will generate if not provided
  name: 'My Project Space',
  agentId: runtime.agentId,
  serverId: 'external-system-id',
  metadata: {
    ownership: {
      ownerId: ownerEntityId,
    },
  },
});
```

For many integrations, worlds are automatically created during connection setup with external platforms like Discord or Slack.

### Ensuring a World Exists

If you're not sure if a world exists, you can use `ensureWorldExists()`:

```typescript
await runtime.ensureWorldExists({
  id: worldId,
  name: 'My Project Space',
  agentId: runtime.agentId,
  serverId: 'external-system-id',
});
```

### Retrieving World Information

```typescript
// Get a specific world
const world = await runtime.getWorld(worldId);

// Get all worlds for the agent
const allWorlds = await runtime.getAllWorlds();
```

### Updating World Properties

```typescript
await runtime.updateWorld({
  id: worldId,
  name: 'Updated Name',
  agentId: runtime.agentId,
  serverId: world.serverId,
  metadata: {
    ...world.metadata,
    customProperty: 'value',
  },
});
```

### Removing a World

```typescript
await runtime.removeWorld(worldId);
```

## World Roles System

Worlds support a role-based permission system with the following roles defined in the `Role` enum:

```typescript
enum Role {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  NONE = 'NONE',
}
```

| Role    | Description                                           |
| ------- | ----------------------------------------------------- |
| `OWNER` | Full control over the world, can assign any roles     |
| `ADMIN` | Administrative capabilities, can manage most settings |
| `NONE`  | Standard participant with no special permissions      |

### Managing Roles

Roles are stored in the world's metadata and can be updated:

```typescript
// Get existing world
const world = await runtime.getWorld(worldId);

// Ensure metadata structure exists
if (!world.metadata) world.metadata = {};
if (!world.metadata.roles) world.metadata.roles = {};

// Assign a role to an entity
world.metadata.roles[entityId] = Role.ADMIN;

// Save the updated world
await runtime.updateWorld(world);
```

## World Settings

Worlds support configurable settings that can be stored and retrieved using utility functions from `@elizaos/core`:

```typescript
import { getWorldSettings, updateWorldSettings } from '@elizaos/core';

// Get settings for a world
const worldSettings = await getWorldSettings(runtime, serverId);

// Update world settings
worldSettings.MY_SETTING = {
  name: 'My Setting',
  description: 'Description for users',
  value: 'setting-value',
  required: false,
};

// Save settings
await updateWorldSettings(runtime, serverId, worldSettings);
```

Settings are stored in the world's metadata and provide a structured way to manage configuration.

## World Events

ElizaOS emits events related to world activities:

| Event             | Description                                    | Payload Type   |
| ----------------- | ---------------------------------------------- | -------------- |
| `WORLD_JOINED`    | Emitted when an agent joins a world            | `WorldPayload` |
| `WORLD_CONNECTED` | Emitted when a world is successfully connected | `WorldPayload` |
| `WORLD_LEFT`      | Emitted when an agent leaves a world           | `WorldPayload` |

### World Event Payload

```typescript
interface WorldPayload extends EventPayload {
  world: World;
  rooms: Room[];
  entities: Entity[];
  source: string;
}
```

### Handling World Events

```typescript
// Register event handlers in your plugin
import { EventType } from '@elizaos/core';

const myPlugin: Plugin = {
  name: 'my-world-plugin',
  description: 'Handles world events',

  events: {
    [EventType.WORLD_JOINED]: [
      async (payload: WorldPayload) => {
        const { world, runtime } = payload;
        console.log(`Joined world: ${world.name}`);
      },
    ],

    [EventType.WORLD_LEFT]: [
      async (payload: WorldPayload) => {
        const { world, runtime } = payload;
        console.log(`Left world: ${world.name}`);
      },
    ],
  },
};
```

## Relationship with Rooms

A world contains multiple rooms that entities can interact in. Each room points back to its parent world via the `worldId` property.

```typescript
// Get all rooms in a world (preferred method)
const worldRooms = await runtime.getRoomsByWorld(worldId);

// Legacy method (deprecated but still available)
const worldRooms = await runtime.getRooms(worldId);
```

When deleting a world, all associated rooms are also deleted:

```typescript
// This will delete all rooms in the world
await runtime.deleteRoomsByWorldId(worldId);
```

See the [Rooms](./rooms.md) documentation for more details on managing rooms within worlds.

## Database Schema

Worlds are stored in the database with the following schema:

- `id`: UUID (primary key, auto-generated)
- `agentId`: UUID (foreign key to agents table, cascade on delete)
- `name`: Text (required)
- `serverId`: Text (required, defaults to 'local')
- `metadata`: JSONB (optional)
- `createdAt`: Timestamp (auto-generated)

## Best Practices

1. **Always include required fields**: When creating or updating worlds, ensure `agentId` and `serverId` are provided
2. **Handle world metadata carefully**: The metadata object can contain critical configuration, so modify it with care
3. **Use appropriate event handlers**: Respond to world events for proper initialization and cleanup
4. **World-room relationship**: Remember that deleting a world cascades to delete all its rooms
5. **Server ID mapping**: Use consistent `serverId` values when mapping to external systems

## Common Patterns

### Platform Integration

When integrating with external platforms:

```typescript
// Discord integration example
await runtime.ensureWorldExists({
  id: createUniqueUuid(runtime.agentId, discordServerId),
  name: discordServerName,
  agentId: runtime.agentId,
  serverId: discordServerId,
  metadata: {
    platform: 'discord',
    serverMetadata: discordServerInfo,
  },
});
```

### Multi-Agent Worlds

Multiple agents can exist in the same world:

```typescript
// Each agent maintains its own world record
const worldId = createUniqueUuid(agentId, serverId);
await runtime.createWorld({
  id: worldId,
  name: 'Shared Space',
  agentId: agentId, // Each agent's specific ID
  serverId: serverId, // Same server ID for all agents
});
```

## Limitations

- Worlds require both `agentId` and `serverId` fields
- Role management is handled through metadata, not as a separate system
- World deletion cascades to all associated rooms and their data
- Settings are stored in metadata and have size limitations based on database JSONB limits
