# Socket.IO Events Documentation

## Overview

ElizaOS uses Socket.IO for real-time bidirectional communication between clients and the server. This document describes all Socket.IO events, their payloads, and usage patterns.

## Connection

### Base URL

```
ws://localhost:3000
```

### Connection Example

```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000', {
  transports: ['websocket'],
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});
```

## Events Reference

### Connection Events

#### `connection` (server-side)

Emitted when a client connects to the server.

#### `connection_established` (server → client)

Sent immediately after successful connection.

**Payload:**

```typescript
{
  message: string;      // "Connected to Eliza Socket.IO server"
  socketId: string;     // Unique socket ID for this connection
  agentId?: string;     // Agent ID if provided during connection
}
```

#### `disconnect` (bidirectional)

Emitted when the connection is terminated.

### Channel/Room Management

#### `join_channel` (client → server)

Join a specific channel for receiving messages. Supports both `channelId` and `roomId` for backward compatibility.

**Payload:**

```typescript
{
  channelId: string;           // Required: Channel UUID to join
  roomId?: string;             // Deprecated: Use channelId instead
  agentId?: string;            // Optional: Agent UUID
  entityId?: string;           // Optional: Entity UUID for world/room creation
  serverId?: string;           // Optional: Server UUID (defaults to '00000000-0000-0000-0000-000000000000')
  metadata?: {                 // Optional: Additional metadata
    isDm?: boolean;            // Is this a direct message channel
    channelType?: string;      // Channel type (DM, GROUP, etc.)
    [key: string]: any;        // Other metadata
  }
}
```

**Example:**

```javascript
socket.emit('join_channel', {
  channelId: '123e4567-e89b-12d3-a456-426614174000',
  agentId: '987fcdeb-51a2-43f1-b012-123456789abc',
  entityId: 'user-123',
  metadata: {
    isDm: true,
  },
});
```

#### `channel_joined` (server → client)

Confirmation that the client has successfully joined a channel.

**Payload:**

```typescript
{
  message: string;      // Success message
  channelId: string;    // Channel UUID that was joined
  roomId: string;       // Same as channelId (backward compatibility)
  agentId?: string;     // Agent UUID if provided
}
```

#### `room_joined` (server → client)

**Deprecated**: Use `channel_joined` instead. Kept for backward compatibility.

### Message Events

#### `send_message` (client → server)

Send a message to a channel.

**Payload:**

```typescript
{
  channelId: string;           // Required: Target channel UUID
  serverId: string;            // Required: Server UUID
  text: string;                // Required: Message content
  entityId: string;            // Required: Sender's entity ID
  entityName?: string;         // Optional: Sender's display name
  messageId?: string;          // Optional: Client-side message ID for tracking
  inReplyToMessageId?: string; // Optional: ID of message being replied to
  attachments?: Array<{        // Optional: File attachments
    url: string;
    type: string;
    [key: string]: any;
  }>;
  metadata?: {                 // Optional: Additional metadata
    [key: string]: any;
  }
}
```

**Example:**

```javascript
socket.emit('send_message', {
  channelId: '123e4567-e89b-12d3-a456-426614174000',
  serverId: '00000000-0000-0000-0000-000000000000',
  text: 'Hello, how can I help you?',
  entityId: 'user-123',
  entityName: 'John Doe',
  messageId: 'client-msg-456',
});
```

#### `messageBroadcast` (server → client)

Broadcast when a new message is sent to a channel. All clients in the channel receive this event.

**Payload:**

```typescript
{
  id: string;                  // Server-assigned message UUID
  senderId: string;            // Sender's UUID
  senderName: string;          // Sender's display name
  text: string;                // Message content
  roomId: string;              // Channel UUID (called roomId for client compatibility)
  serverId: string;            // Server UUID
  createdAt: number;           // Unix timestamp
  source: string;              // Message source type
  clientMessageId?: string;    // Original client message ID (only sent back to sender)
  thought?: string;            // Agent's internal thought process
  actions?: any[];             // Agent actions taken
  attachments?: any[];         // Message attachments
}
```

#### `messageAck` (server → client)

Acknowledgment sent only to the message sender confirming message was processed.

**Payload:**

```typescript
{
  clientMessageId?: string;    // Original client-side message ID
  messageId: string;           // Server-assigned message UUID
  status: 'success';           // Processing status
}
```

#### `messageError` (server → client)

Sent when there's an error processing a message.

**Payload:**

```typescript
{
  error: string;               // Error message
  clientMessageId?: string;    // Client message ID if available
}
```

#### `messageComplete` (server → client)

Emitted when an agent finishes processing and responding to a message.

**Payload:**

```typescript
{
  channelId: string; // Channel UUID
  serverId: string; // Server UUID
}
```

### Message Management Events

#### `messageDeleted` (server → client)

Broadcast when a message is deleted from a channel.

**Payload:**

```typescript
{
  messageId: string; // Deleted message UUID
  channelId: string; // Channel UUID
}
```

#### `channelCleared` (server → client)

Broadcast when all messages in a channel are cleared.

**Payload:**

```typescript
{
  channelId: string; // Cleared channel UUID
}
```

### Channel Management Events

#### `channelUpdated` (server → client)

Broadcast when channel properties are updated.

**Payload:**

```typescript
{
  channelId: string;           // Updated channel UUID
  updates: {                   // Updated properties
    name?: string;
    topic?: string;
    metadata?: any;
    [key: string]: any;
  }
}
```

#### `channelDeleted` (server → client)

Broadcast when a channel is deleted.

**Payload:**

```typescript
{
  channelId: string; // Deleted channel UUID
}
```

### Log Streaming Events

#### `subscribe_logs` (client → server)

Subscribe to real-time log updates.

**Example:**

```javascript
socket.emit('subscribe_logs');
```

#### `log_subscription_confirmed` (server → client)

Confirmation of log subscription.

**Payload:**

```typescript
{
  subscribed: boolean; // true
  message: string; // "Successfully subscribed to log stream"
}
```

#### `unsubscribe_logs` (client → server)

Unsubscribe from log updates.

#### `set_log_filter` (client → server)

Filter which logs to receive.

**Payload:**

```typescript
{
  level?: 'debug' | 'info' | 'warn' | 'error';  // Minimum log level
  agentId?: string;                              // Filter by agent
  category?: string;                             // Filter by category
}
```

#### `log_update` (server → client)

Real-time log entry.

**Payload:**

```typescript
{
  id: string;                  // Log entry ID
  timestamp: string;           // ISO timestamp
  level: string;               // Log level
  category: string;            // Log category
  message: string;             // Log message
  data?: any;                  // Additional log data
  agentId?: string;            // Associated agent ID
}
```

## Error Handling

All client-to-server events may result in a `messageError` event if validation fails or an error occurs.

Common error scenarios:

- Missing required fields
- Invalid UUID formats
- Agent not found
- Channel not found
- Insufficient permissions

## Message Flow Example

```javascript
// 1. Connect to server
const socket = io('http://localhost:3000');

// 2. Wait for connection
socket.on('connection_established', (data) => {
  console.log('Connected:', data);

  // 3. Join a channel
  socket.emit('join_channel', {
    channelId: 'channel-uuid',
    agentId: 'agent-uuid',
    entityId: 'user-123',
  });
});

// 4. Handle channel joined
socket.on('channel_joined', (data) => {
  console.log('Joined channel:', data);

  // 5. Send a message
  socket.emit('send_message', {
    channelId: data.channelId,
    serverId: 'server-uuid',
    text: 'Hello!',
    entityId: 'user-123',
    entityName: 'User',
  });
});

// 6. Listen for messages
socket.on('messageBroadcast', (message) => {
  console.log('New message:', message);
});

// 7. Handle errors
socket.on('messageError', (error) => {
  console.error('Message error:', error);
});
```

## Migration Notes

### Deprecated Events

- `room_joined` → Use `channel_joined`
- `roomId` parameter → Use `channelId`

### Backward Compatibility

The system maintains backward compatibility by:

1. Accepting both `roomId` and `channelId` parameters (channelId preferred)
2. Emitting both `room_joined` and `channel_joined` events
3. Including `roomId` in responses (same value as `channelId`)

## Best Practices

1. **Always provide channelId** when joining channels or sending messages
2. **Use entityId consistently** across all events for proper user tracking
3. **Handle connection errors** with reconnection logic
4. **Subscribe to error events** to handle failures gracefully
5. **Use message IDs** for tracking message delivery and acknowledgments
6. **Implement heartbeat/ping** for connection monitoring in production

## Rate Limits

Socket.IO connections are subject to the same rate limits as HTTP API endpoints:

- Default: 60 requests per minute per IP
- Configurable via environment variables
