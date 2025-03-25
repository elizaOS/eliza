---
sidebar_position: 8
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
  agentId?: UUID;
  source: string;
  type: ChannelType;
  channelId?: string;
  serverId?: string;
  worldId?: UUID;
  metadata?: Record<string, unknown>;
};
```

| Property    | Description                                                      |
| ----------- | ---------------------------------------------------------------- |
| `id`        | Unique identifier for the room                                   |
| `name`      | Optional display name for the room                               |
| `agentId`   | Optional ID of the agent associated with this room               |
| `source`    | The platform or origin of the room (e.g., 'discord', 'telegram') |
| `type`      | Type of room (DM, GROUP, THREAD, etc.)                           |
| `channelId` | External system channel identifier                               |
| `serverId`  | External system server identifier                                |
| `worldId`   | Optional ID of the parent world                                  |
| `metadata`  | Additional room configuration data                               |

## Room Types

ElizaOS supports several room types, defined in the `ChannelType` enum:

| Type          | Description                               |
| ------------- | ----------------------------------------- |
| `SELF`        | Messages to self                          |
| `DM`          | Direct messages between two participants  |
| `GROUP`       | Group messages with multiple participants |
| `VOICE_DM`    | Voice direct messages                     |
| `VOICE_GROUP` | Voice channels with multiple participants |
| `FEED`        | Social media feed                         |
| `THREAD`      | Threaded conversation                     |
| `WORLD`       | World channel                             |
| `FORUM`       | Forum discussion                          |
| `API`         | Legacy type - Use DM or GROUP instead     |

## Room Creation and Management

### Creating a Room

You can create a new room using the AgentRuntime:

```typescript
const roomId = await runtime.createRoom({
  name: 'general-chat',
  source: 'discord',
  type: ChannelType.GROUP,
  channelId: 'external-channel-id',
  serverId: 'external-server-id',
  worldId: parentWorldId,
});
```

### Ensuring a Room Exists

To create a room if it doesn't already exist:

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
// Get a specific room
const room = await runtime.getRoom(roomId);

// Get all rooms in a world
const worldRooms = await runtime.getRooms(worldId);
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

```typescript
await runtime.deleteRoom(roomId);
```

## Participants in Rooms

Rooms can have multiple participants (entities) that can exchange messages.

### Managing Room Participants

```typescript
// Add a participant to a room
await runtime.addParticipant(entityId, roomId);

// Remove a participant from a room
await runtime.removeParticipant(entityId, roomId);

// Get all participants in a room
const participants = await runtime.getParticipantsForRoom(roomId);

// Get all rooms where an entity is a participant
const entityRooms = await runtime.getRoomsForParticipant(entityId);
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

## Following and Unfollowing Rooms

ElizaOS allows agents to "follow" rooms to actively participate in conversations without being explicitly mentioned. This functionality is managed through the `FOLLOW_ROOM` and `UNFOLLOW_ROOM` actions.

```typescript
// Follow a room (typically triggered by an action)
await runtime.setParticipantUserState(roomId, runtime.agentId, 'FOLLOWED');

// Unfollow a room
await runtime.setParticipantUserState(roomId, runtime.agentId, null);
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
  'messages'
);

// Retrieve recent messages from a room
const messages = await runtime.getMemories({
  roomId: roomId,
  count: 10,
  unique: true,
});
```

## Events Related to Rooms

ElizaOS emits events related to room activities:

| Event              | Description                                  |
| ------------------ | -------------------------------------------- |
| `ROOM_JOINED`      | Emitted when an entity joins a room          |
| `ROOM_LEFT`        | Emitted when an entity leaves a room         |
| `MESSAGE_RECEIVED` | Emitted when a message is received in a room |
| `MESSAGE_SENT`     | Emitted when a message is sent to a room     |

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

1. **Use appropriate room types**: Select the most appropriate room type for each interaction context
2. **Follow relationship order**: Create worlds before creating rooms, as rooms often have a parent world
3. **Use ensureRoomExists**: Use this method to avoid duplicate rooms when syncing with external systems
4. **Clean up rooms**: Delete rooms when they're no longer needed to prevent database bloat
5. **Room metadata**: Use metadata for room-specific configuration that doesn't fit into the standard properties
6. **Follow state management**: Implement clear rules for when agents should follow or unfollow rooms
7. **Handle participants carefully**: Ensure that participant management aligns with external platform behavior
