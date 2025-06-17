---
sidebar_position: 8
title: Rooms System
description: Understanding ElizaOS rooms - interaction spaces for entities to exchange messages and communicate
keywords: [rooms, channels, conversations, participants, messages, interaction, communication]
image: /img/elizaos-rooms-simplified.svg
---

# Rooms

Rooms in ElizaOS represent individual interaction spaces within a world. A room can be a conversation, a channel, a thread, or any other defined space where entities can exchange messages and interact. Rooms are typically contained within a world, though they can also exist independently.

![](/img/elizaos-rooms-simplified.svg)

## Room Structure

A room in ElizaOS has the following properties:

```typescript
type Room = {
  id: UUID;
  name?: string;
  agentId: UUID; // Required - the agent that owns this room
  source: string; // Platform origin (e.g., 'discord', 'telegram')
  type: ChannelType; // Type of room (DM, GROUP, etc.)
  channelId?: string; // External system channel identifier
  serverId?: string; // External system server identifier
  worldId?: UUID; // Parent world ID (optional)
  metadata?: Record<string, unknown>;
};
```

| Property    | Description                                                      | Required |
| ----------- | ---------------------------------------------------------------- | -------- |
| `id`        | Unique identifier for the room                                   | Yes      |
| `name`      | Display name for the room                                        | No       |
| `agentId`   | ID of the agent that owns this room                              | Yes      |
| `source`    | The platform or origin of the room (e.g., 'discord', 'telegram') | Yes      |
| `type`      | Type of room (DM, GROUP, THREAD, etc.)                           | Yes      |
| `channelId` | External system channel identifier                               | No       |
| `serverId`  | External system server identifier                                | No       |
| `worldId`   | ID of the parent world                                           | No       |
| `metadata`  | Additional room configuration data                               | No       |

## Room Types

ElizaOS supports several room types, defined in the `ChannelType` enum:

| Type          | Description                               | Common Use Case       |
| ------------- | ----------------------------------------- | --------------------- |
| `SELF`        | Agent's own room for internal messages    | Agent initialization  |
| `DM`          | Direct messages between two participants  | Private conversations |
| `GROUP`       | Group messages with multiple participants | Team chats, channels  |
| `VOICE_DM`    | Voice direct messages                     | Voice calls           |
| `VOICE_GROUP` | Voice channels with multiple participants | Voice meetings        |
| `FEED`        | Social media feed                         | Twitter, Instagram    |
| `THREAD`      | Threaded conversation                     | Forum discussions     |
| `WORLD`       | World-level channel                       | World announcements   |
| `FORUM`       | Forum discussion                          | Q&A platforms         |

## Room Creation and Management

### Creating a Room

When creating a room, the `agentId` is automatically set from the runtime:

```typescript
const roomId = await runtime.createRoom({
  id: customRoomId, // Optional - will generate if not provided
  name: 'general-chat',
  source: 'discord',
  type: ChannelType.GROUP,
  channelId: 'external-channel-id',
  serverId: 'external-server-id',
  worldId: parentWorldId, // Optional
});
```

### Creating Multiple Rooms

You can create multiple rooms at once for better performance:

```typescript
const roomIds = await runtime.createRooms([
  {
    name: 'general',
    source: 'discord',
    type: ChannelType.GROUP,
    worldId: worldId,
  },
  {
    name: 'announcements',
    source: 'discord',
    type: ChannelType.GROUP,
    worldId: worldId,
  },
]);
```

### Ensuring a Room Exists

To create a room only if it doesn't already exist:

```typescript
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

### Retrieving Room Information

```typescript
// Get a single room by ID
const room = await runtime.getRoom(roomId);

// Get multiple rooms by IDs
const rooms = await runtime.getRoomsByIds([roomId1, roomId2, roomId3]);

// Get all rooms in a world (preferred method)
const worldRooms = await runtime.getRoomsByWorld(worldId);

// Deprecated - use getRoomsByWorld instead
// const worldRooms = await runtime.getRooms(worldId);
```

### Updating Room Properties

```typescript
await runtime.updateRoom({
  id: roomId,
  name: 'renamed-channel',
  metadata: {
    ...room.metadata,
    customProperty: 'value',
  },
});
```

### Deleting a Room

**⚠️ Warning**: Deleting a room will also delete:

- All messages in the room
- All embeddings for those messages
- All participant relationships
- All logs associated with the room

```typescript
await runtime.deleteRoom(roomId);
```

### Deleting All Rooms in a World

Delete all rooms associated with a specific world:

```typescript
await runtime.deleteRoomsByWorldId(worldId);
```

## Participants in Rooms

Rooms can have multiple participants (entities) that can exchange messages.

### Managing Room Participants

```typescript
// Add a single participant to a room
await runtime.addParticipant(entityId, roomId);

// Add multiple participants at once (more efficient)
await runtime.addParticipantsRoom([entityId1, entityId2, entityId3], roomId);

// Remove a participant from a room
await runtime.removeParticipant(entityId, roomId);

// Get all participants in a room
const participantIds = await runtime.getParticipantsForRoom(roomId);

// Get all rooms where an entity is a participant
const entityRooms = await runtime.getRoomsForParticipant(entityId);

// Get rooms for multiple participants
const sharedRooms = await runtime.getRoomsForParticipants([entityId1, entityId2]);
```

### Participant States

Participants can have different states in a room:

```typescript
// Get a participant's state in a room
const state = await runtime.getParticipantUserState(roomId, entityId);
// Returns: 'FOLLOWED', 'MUTED', or null

// Set a participant's state in a room
await runtime.setParticipantUserState(roomId, entityId, 'FOLLOWED');
```

The participant states are:

| State      | Description                                                                               |
| ---------- | ----------------------------------------------------------------------------------------- |
| `FOLLOWED` | The agent actively follows the conversation and responds without being directly mentioned |
| `MUTED`    | The agent ignores messages in this room                                                   |
| `null`     | Default state - the agent responds only when directly mentioned                           |

## Self Rooms

Every agent automatically gets a "self" room during initialization. This is a special room where:

- The room ID equals the agent ID
- The room type is `SELF`
- The agent is automatically added as a participant
- Used for internal agent operations and self-directed messages

```typescript
// During agent initialization, this happens automatically:
const selfRoom = await runtime.createRoom({
  id: runtime.agentId,
  name: runtime.character.name,
  source: 'elizaos',
  type: ChannelType.SELF,
  channelId: runtime.agentId,
  serverId: runtime.agentId,
  worldId: runtime.agentId,
});
```

## Memory and Messages in Rooms

Rooms store messages as memories in the database:

```typescript
// Create a new message in a room
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
  'messages' // table name
);

// Retrieve recent messages from a room
const messages = await runtime.getMemories({
  roomId: roomId,
  tableName: 'messages',
  count: 10,
  unique: true,
});

// Get messages from multiple rooms
const multiRoomMessages = await runtime.getMemoriesByRoomIds({
  roomIds: [roomId1, roomId2],
  tableName: 'messages',
  limit: 50,
});
```

## Events Related to Rooms

ElizaOS emits events related to room activities:

| Event              | Description                                  | Payload                         |
| ------------------ | -------------------------------------------- | ------------------------------- |
| `ROOM_JOINED`      | Emitted when an entity joins a room          | `{ runtime, entityId, roomId }` |
| `ROOM_LEFT`        | Emitted when an entity leaves a room         | `{ runtime, entityId, roomId }` |
| `MESSAGE_RECEIVED` | Emitted when a message is received in a room | `{ runtime, message }`          |
| `MESSAGE_SENT`     | Emitted when a message is sent to a room     | `{ runtime, message }`          |

### Handling Room Events

```typescript
// Register event handlers in your plugin
const myPlugin: Plugin = {
  name: 'my-room-plugin',
  description: 'Handles room events',

  events: {
    [EventTypes.ROOM_JOINED]: [
      async (payload) => {
        const { runtime, entityId, roomId } = payload;
        console.log(`Entity ${entityId} joined room ${roomId}`);
      },
    ],

    [EventTypes.MESSAGE_RECEIVED]: [
      async (payload: MessagePayload) => {
        const { runtime, message } = payload;
        console.log(`Message received in room ${message.roomId}`);
      },
    ],
  },
};
```

## Room Connection with External Systems

When integrating with external platforms, rooms are typically mapped to channels, conversations, or other interaction spaces:

```typescript
// Ensure the connection exists for a room from an external system
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

1. **Always specify agentId**: While the runtime sets it automatically, be aware that rooms are agent-specific
2. **Use appropriate room types**: Select the most appropriate room type for each interaction context
3. **Create worlds first**: If using worlds, create them before creating rooms
4. **Use batch operations**: When creating multiple rooms or adding multiple participants, use batch methods
5. **Use ensureRoomExists**: This prevents duplicate rooms when syncing with external systems
6. **Be careful with deletion**: Remember that deleting rooms cascades to all related data
7. **Use metadata wisely**: Store platform-specific data in metadata rather than creating new fields
8. **Handle participant states**: Implement clear rules for when agents should follow or mute rooms

## Common Patterns

### Creating a DM Room

```typescript
// Create a direct message room between agent and user
const dmRoom = await runtime.createRoom({
  name: `DM-${userId}`,
  source: 'discord',
  type: ChannelType.DM,
  metadata: {
    participants: [runtime.agentId, userId],
  },
});

// Add both participants
await runtime.addParticipantsRoom([runtime.agentId, userId], dmRoom);
```

### Platform Integration Example

```typescript
// Discord channel integration
async function syncDiscordChannel(channel: DiscordChannel, guildId: string) {
  // Ensure world exists for the Discord server
  await runtime.ensureWorldExists({
    id: createUniqueUuid(runtime.agentId, guildId),
    name: `Discord Server ${guildId}`,
    serverId: guildId,
  });

  // Ensure room exists for the channel
  await runtime.ensureRoomExists({
    id: createUniqueUuid(runtime.agentId, channel.id),
    name: channel.name,
    source: 'discord',
    type: channel.type === 'text' ? ChannelType.GROUP : ChannelType.VOICE_GROUP,
    channelId: channel.id,
    serverId: guildId,
    worldId: createUniqueUuid(runtime.agentId, guildId),
  });
}
```
