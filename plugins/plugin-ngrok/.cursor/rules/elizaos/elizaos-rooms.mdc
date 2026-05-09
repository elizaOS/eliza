---
description: Rooms are an agent abstraction for the agent to track entities in a room, which could be a channel on a message server or a room in a 3D world platform. Rooms have participants, and all messages are tied to rooms, even autonomous messages.
globs:
alwaysApply: false
---

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

```typescript
const feedRoom = {
  id: createUniqueUuid(runtime, `${userId}-feed`),
  name: `${userName}'s Feed`,
  source: 'twitter',
  type: ChannelType.FEED,
  worldId: userWorldId,
};
```
