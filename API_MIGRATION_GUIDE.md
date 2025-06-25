# API Migration Guide

This guide helps developers migrate from deprecated or incorrect API endpoints to the current ElizaOS API implementation.

## Overview of Changes

### 1. Message Submission - Critical Change

The agent-specific message endpoint has been removed in favor of a central messaging system.

**❌ OLD (No longer exists):**
```
POST /api/agents/{agentId}/message
```

**✅ NEW:**
```
POST /api/messaging/submit
```

### 2. Audio Endpoints - Path Correction

Audio endpoints have moved from the agents namespace to their own audio namespace.

**❌ OLD:**
```
POST /api/agents/{agentId}/audio-messages
POST /api/agents/{agentId}/audio-messages/synthesize
POST /api/agents/{agentId}/speech/generate
POST /api/agents/{agentId}/speech/conversation
```

**✅ NEW:**
```
POST /api/audio/{agentId}/audio-messages
POST /api/audio/{agentId}/audio-messages/synthesize
POST /api/audio/{agentId}/speech/generate
POST /api/audio/{agentId}/speech/conversation
```

## Detailed Migration Instructions

### Migrating Message Submission

The new central messaging system provides better routing, multi-agent support, and consistent message handling.

#### Before (Incorrect):
```javascript
// This endpoint doesn't exist!
const response = await fetch('/api/agents/123e4567-e89b-12d3-a456-426614174000/message', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    senderId: 'user123',
    roomId: 'room456',
    text: 'Hello agent!',
    source: 'api'
  })
});
```

#### After (Correct):
```javascript
const response = await fetch('/api/messaging/submit', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    channel_id: 'room456',  // This is your room/channel ID
    server_id: '00000000-0000-0000-0000-000000000000',  // Use default server ID
    author_id: 'user123',   // ID of the message author
    content: 'Hello agent!',
    source_type: 'user_message',
    raw_message: {
      text: 'Hello agent!'
    },
    metadata: {
      platform: 'api',
      // Include agent_name if the author is an agent
    }
  })
});
```

### Key Changes in Message Structure:

| Old Field | New Field | Notes |
|-----------|-----------|-------|
| `senderId` | `author_id` | ID of the message author (user or agent) |
| `roomId` | `channel_id` | The channel/room where the message is posted |
| `text` | `content` | The message text content |
| `source` | `source_type` | Type of source (e.g., 'user_message', 'agent_response') |
| N/A | `server_id` | Required field - use default UUID for simple setups |
| N/A | `raw_message` | Object containing the raw message data |

### Migrating Audio Endpoints

Simply update the base path from `/api/agents/` to `/api/audio/`:

#### Before:
```javascript
// Text to speech
const response = await fetch('/api/agents/123e4567-e89b-12d3-a456-426614174000/audio-messages/synthesize', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    text: 'Hello, how can I help you?'
  })
});
```

#### After:
```javascript
// Text to speech
const response = await fetch('/api/audio/123e4567-e89b-12d3-a456-426614174000/audio-messages/synthesize', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    text: 'Hello, how can I help you?'
  })
});
```

### WebSocket to Socket.IO Migration

If you were using raw WebSocket connections, migrate to Socket.IO client:

#### Before (Generic WebSocket):
```javascript
const ws = new WebSocket('ws://localhost:3000/websocket');
ws.on('message', (data) => {
  // Handle message
});
```

#### After (Socket.IO):
```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000');

// Join a room
socket.emit('join', {
  roomId: 'room456',
  agentId: '123e4567-e89b-12d3-a456-426614174000'
});

// Listen for messages
socket.on('messageBroadcast', (data) => {
  console.log('New message:', data);
  // data includes: senderId, senderName, text, roomId, serverId, createdAt, etc.
});

// Send a message
socket.emit('message', {
  text: 'Hello from Socket.IO!',
  roomId: 'room456',
  userId: 'user123',
  name: 'User Name'
});
```

## Benefits of the New Architecture

### Central Messaging System

1. **Multi-Agent Support**: Messages can be processed by multiple agents in the same channel
2. **Better Routing**: Central bus handles message distribution intelligently
3. **Consistent State**: All messages flow through a single system ensuring consistency
4. **Scalability**: Easier to scale horizontally with a central message bus

### Audio API Separation

1. **Clear Domain Boundaries**: Audio processing is separate from agent management
2. **Independent Scaling**: Audio services can be scaled independently
3. **Better Organization**: Clearer API structure with domain-specific namespaces

## Common Questions

### Q: How do I send a message to a specific agent?

A: Messages are sent to channels, not directly to agents. Agents monitor channels and respond based on their configuration. Use the `channel_id` to specify where the message should go.

### Q: What is the default server_id?

A: Use `00000000-0000-0000-0000-000000000000` as the default server ID for simple setups.

### Q: How do I know which agent will respond?

A: Agents that are members of the channel will process the message. The routing is handled by the central messaging system based on agent availability and configuration.

### Q: Can I still use audio endpoints with the old path?

A: No, the old paths under `/api/agents/` no longer exist. You must use the new `/api/audio/` paths.

## Testing Your Migration

1. Update all API calls to use the new endpoints
2. Test message submission through `/api/messaging/submit`
3. Verify audio endpoints work with `/api/audio/` prefix
4. Update WebSocket connections to use Socket.IO
5. Test real-time message delivery through Socket.IO events

## Need Help?

If you encounter issues during migration:

1. Check the [API Validation Report](./API_VALIDATION_REPORT.md) for detailed endpoint information
2. Review the OpenAPI specification at `/packages/docs/src/openapi/eliza-v1.yaml`
3. Test endpoints using the updated Postman collection
4. Join the ElizaOS community for support

Remember: The key change is that messages now flow through a central system (`/api/messaging/submit`) rather than direct agent endpoints. This provides better scalability and multi-agent support.