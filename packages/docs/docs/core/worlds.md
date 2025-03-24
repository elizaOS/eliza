---
sidebar_position: 7
---

# Worlds

Worlds in ElizaOS are collections of entities (users, agents) and rooms (conversations, channels) that form a cohesive environment for interactions. Think of a world as a virtual space, like a Discord server, Slack workspace, or 3D MMO environment, where entities can communicate across multiple channels or areas.

| Worlds                                    | Rooms within Worlds                     |
| ----------------------------------------- | --------------------------------------- |
| ![](/img/elizaos-worlds-cosmic-clean.svg) | ![](/img/elizaos-worlds-simplified.svg) |

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

| Property   | Description                                          |
| ---------- | ---------------------------------------------------- |
| `id`       | Unique identifier for the world                      |
| `name`     | Optional display name                                |
| `agentId`  | ID of the agent managing this world                  |
| `serverId` | External system identifier (e.g., Discord server ID) |
| `metadata` | Additional world configuration data                  |

The metadata can store custom information, including ownership details and role assignments for entities within the world.

## World Creation and Management

### Creating a World

You can create a new world using the AgentRuntime:

```typescript
const worldId = await runtime.createWorld({
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

// Get all worlds
const allWorlds = await runtime.getAllWorlds();
```

### Updating World Properties

```typescript
await runtime.updateWorld({
  id: worldId,
  name: 'Updated Name',
  metadata: {
    ...world.metadata,
    customProperty: 'value',
  },
});
```

## World Roles System

Worlds support a role-based permission system with the following roles:

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

// Ensure roles object exists
if (!world.metadata) world.metadata = {};
if (!world.metadata.roles) world.metadata.roles = {};

// Assign a role to an entity
world.metadata.roles[entityId] = Role.ADMIN;

// Save the world
await runtime.updateWorld(world);
```

For programmatic role management, you can use role-related utilities:

```typescript
import { canModifyRole, findWorldForOwner } from '@elizaos/core';

// Check if user can modify roles
if (canModifyRole(userRole, targetRole, newRole)) {
  // Allow role change
}

// Find world where user is owner
const userWorld = await findWorldForOwner(runtime, entityId);
```

## World Settings

Worlds support configurable settings that can be stored and retrieved:

```typescript
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

## World Events

ElizaOS emits events related to world activities:

| Event             | Description                                    |
| ----------------- | ---------------------------------------------- |
| `WORLD_JOINED`    | Emitted when an agent joins a world            |
| `WORLD_CONNECTED` | Emitted when a world is successfully connected |
| `WORLD_LEFT`      | Emitted when an agent leaves a world           |

### Handling World Events

```typescript
// Register event handlers in your plugin
const myPlugin: Plugin = {
  name: 'my-world-plugin',
  description: 'Handles world events',

  events: {
    [EventTypes.WORLD_JOINED]: [
      async (payload: WorldPayload) => {
        const { world, runtime } = payload;
        console.log(`Joined world: ${world.name}`);
      },
    ],

    [EventTypes.WORLD_LEFT]: [
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
// Get all rooms in a world
const worldRooms = await runtime.getRooms(worldId);
```

See the [Rooms](./rooms.md) documentation for more details on managing rooms within worlds.

## Best Practices

1. **Always check permissions**: Before performing administrative actions, verify the user has appropriate roles
2. **Handle world metadata carefully**: The metadata object can contain critical configuration, so modify it with care
3. **World-room syncing**: When syncing with external platforms, keep world and room structures in alignment
4. **Event-driven architecture**: Use events to respond to world changes rather than polling for updates
5. **Default settings**: Provide sensible defaults for world settings to make configuration easier
