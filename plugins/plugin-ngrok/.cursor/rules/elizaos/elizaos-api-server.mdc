---
description: API servers, API services, backend routes, Express, HTTP REST, Websocket communications, anything bacend, simulating a real messaging server, connecting frontend to backend
globs:
alwaysApply: false
---

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
```

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
