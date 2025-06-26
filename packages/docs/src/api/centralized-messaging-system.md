# Centralized Messaging System Documentation

## Overview

ElizaOS uses a centralized messaging system that provides a scalable, multi-agent architecture for handling messages. Instead of sending messages directly to specific agents, all messages flow through a central bus that intelligently routes them to the appropriate agents based on channel membership and server subscriptions.

## Architecture

### Core Components

1. **Central Message Bus** - An event-driven system that distributes messages to subscribed agents
2. **Message API** - REST endpoints for submitting and managing messages
3. **Message Service** - Agent-side service that subscribes to and processes messages
4. **Channel System** - Logical groupings for message routing
5. **Server System** - Higher-level groupings of channels (worlds in agent terminology)

### Message Flow Diagram

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌─────────────┐
│   Client    │────▶│ Message API  │────▶│  Internal   │────▶│   Agent(s)  │
│   (User)    │     │/ingest-ext.  │     │ Message Bus │     │  Services   │
└─────────────┘     └──────────────┘     └─────────────┘     └─────────────┘
                           │                      │                    │
                           ▼                      │                    ▼
                    ┌──────────────┐              │            ┌─────────────┐
                    │   Database   │              │            │   Process   │
                    │   Storage    │              │            │   Message   │
                    └──────────────┘              │            └─────────────┘
                                                  │                    │
                                                  │                    ▼
                    ┌──────────────┐              │            ┌─────────────┐
                    │  Socket.IO   │◀─────────────┴────────────│   Response  │
                    │  Broadcast   │                           │     API     │
                    └──────────────┘                           └─────────────┘
```

## Key Concepts

### Channels
- **Definition**: A channel is a logical space where messages are exchanged
- **UUID**: Each channel has a unique identifier
- **Purpose**: Groups related conversations and participants
- **Types**: Direct Message (DM) or Group channels

### Servers (Worlds)
- **Definition**: A higher-level grouping that contains multiple channels
- **UUID**: Each server has a unique identifier
- **Default**: `00000000-0000-0000-0000-000000000000` for simple setups
- **Purpose**: Represents different contexts or environments (e.g., different Discord servers)

### Message Bus
- **Type**: In-memory EventEmitter (single process)
- **Events**: `new_message`, `message_deleted`, `channel_cleared`, `server_agent_update`
- **Scalability**: Can be replaced with Redis Pub/Sub, Kafka, or RabbitMQ for multi-process deployments

## API Endpoints

### Submit Message
```
POST /api/messaging/submit
```

Submits a message FROM agents or system components. This endpoint is for messages that have already been processed (e.g., agent responses) and does NOT publish to the internal message bus.

**Request Body:**
```json
{
  "channel_id": "550e8400-e29b-41d4-a716-446655440000",
  "server_id": "00000000-0000-0000-0000-000000000000",
  "author_id": "123e4567-e89b-12d3-a456-426614174000",
  "content": "Hello, I need help with my account",
  "source_type": "user_message",
  "raw_message": {
    "text": "Hello, I need help with my account"
  },
  "metadata": {
    "platform": "web",
    "user_name": "John Doe"
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "987fcdeb-51a2-43f1-b012-123456789abc",
    "channelId": "550e8400-e29b-41d4-a716-446655440000",
    "authorId": "123e4567-e89b-12d3-a456-426614174000",
    "content": "Hello, I need help with my account",
    "createdAt": "2024-01-01T12:00:00.000Z"
  }
}
```

### Ingest External Message
```
POST /api/messaging/ingest-external
```

Ingests messages from external platforms (Discord, Twitter, etc.) into the central system.

**Key Difference**: This endpoint publishes to the internal message bus for agent processing, while `/submit` is for agent responses and system messages that don't need agent processing.

**Request Body:**
```json
{
  "channel_id": "550e8400-e29b-41d4-a716-446655440000",
  "server_id": "00000000-0000-0000-0000-000000000000",
  "author_id": "external-user-123",
  "author_display_name": "John Doe",
  "content": "Hello from Discord!",
  "source_id": "discord-msg-456",
  "source_type": "discord",
  "metadata": {
    "discord_guild_id": "123456789",
    "discord_channel_id": "987654321"
  }
}
```

### Mark Message Complete
```
POST /api/messaging/complete
```

Notifies that an agent has finished processing a message.

**Request Body:**
```json
{
  "channel_id": "550e8400-e29b-41d4-a716-446655440000",
  "server_id": "00000000-0000-0000-0000-000000000000"
}
```

## Message Processing Flow

### 1. Message Submission
Messages follow different paths based on their source:

**For External Messages** (`/api/messaging/ingest-external`):
1. Message is validated (required fields, UUID formats)
2. Message is stored in the database
3. Message is published to the internal message bus for agent processing
4. Message is broadcast via Socket.IO for real-time updates

**For Agent Responses** (`/api/messaging/submit`):
1. Message is validated
2. Message is stored in the database
3. Message is broadcast via Socket.IO for real-time updates
4. NO publication to internal bus (already processed)

### 2. Agent Message Reception
Each agent's MessageBusService listens for messages:

```javascript
internalMessageBus.on('new_message', this.handleIncomingMessage);
```

### 3. Message Validation
Before processing, agents validate:

1. **Channel Participation**: Is the agent a participant in this channel?
2. **Server Subscription**: Is the agent subscribed to this server?
3. **Not Self-Message**: Did the agent author this message?
4. **Channel Validity**: Is this a valid channel for the agent?

### 4. Message Processing
If validation passes:

1. **World/Room Mapping**: Agent creates unique UUIDs for its internal representation
   - `agentWorldId = createUniqueUuid(runtime, message.server_id)`
   - `agentRoomId = createUniqueUuid(runtime, message.channel_id)`
   - This ensures each agent has its own unique view of shared spaces

2. **Memory Creation**: Agent creates a memory record with:
   - Unique memory ID based on the original message ID
   - Agent-specific entity ID for the author
   - Room and world IDs from agent's perspective
   - Original message metadata preserved

3. **Event Emission**: Emits `MESSAGE_RECEIVED` event with:
   - The agent memory (not the original message)
   - A callback function for sending responses
   - An onComplete handler for cleanup

4. **Plugin Processing**: Bootstrap and other plugins:
   - Evaluate the message context
   - Generate appropriate responses
   - May choose to IGNORE messages
   - Execute the callback with response content

### 5. Response Handling
When an agent generates a response:

1. Response is sent back through `/api/messaging/submit` (as an already-processed message)
2. Response is stored in the database
3. Response is broadcast via Socket.IO
4. NO publication to message bus (it's already been processed)
5. Completion notification is sent via `/api/messaging/complete`

## Agent Configuration

### Channel Participation
Agents must be added as participants to channels to receive messages:

```javascript
// Add agent to channel
await runtime.addParticipant(agentId, channelId);
```

### Server Subscription
Agents automatically subscribe to servers they belong to:

```javascript
// Agent fetches its server list on startup
const servers = await fetch(`/api/messaging/agents/${agentId}/servers`);
```

## Message Structure

### Internal Message Format
```typescript
interface MessageServiceMessage {
  id: UUID;                      // Unique message ID
  channel_id: UUID;              // Target channel
  server_id: UUID;               // Parent server
  author_id: UUID;               // Message author
  author_display_name?: string;  // Display name
  content: string;               // Message content
  raw_message?: any;             // Original message data
  source_id?: string;            // Platform-specific ID
  source_type?: string;          // Platform identifier
  in_reply_to_message_id?: UUID; // Reply threading
  created_at: number;            // Unix timestamp
  metadata?: any;                // Additional data
}

// Agent's internal memory representation
interface AgentMemory {
  id: UUID;                      // Unique to agent (derived from message.id)
  entityId: UUID;                // Agent's unique ID for the author
  content: Content;              // Parsed content object
  roomId: UUID;                  // Agent's unique room UUID
  worldId: UUID;                 // Agent's unique world UUID
  agentId: UUID;                 // The agent that owns this memory
  metadata: {
    sourceId: UUID;              // Original message.id for reference
    // ... other metadata
  }
}
```

## Real-time Updates

The system broadcasts real-time updates via Socket.IO:

### Message Broadcast Event
```javascript
socket.on('messageBroadcast', (data) => {
  console.log('New message:', {
    id: data.id,
    senderId: data.senderId,
    senderName: data.senderName,
    text: data.text,
    roomId: data.roomId,        // Same as channel_id
    serverId: data.serverId,
    createdAt: data.createdAt,
    source: data.source
  });
});
```

## Example: Complete Message Flow

### 1. User Sends Message
```javascript
// Client sends message via external ingestion endpoint
const response = await fetch('/api/messaging/ingest-external', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    channel_id: 'channel-123',
    server_id: '00000000-0000-0000-0000-000000000000',
    author_id: 'user-456',
    author_display_name: 'Alice',
    content: 'What is the weather today?',
    source_type: 'web_client',
    metadata: { browser: 'Chrome' }
  })
});
// This will publish to the internal message bus for agent processing
```

### 2. Message Bus Distribution
```javascript
// Internal: Message published to bus
internalMessageBus.emit('new_message', messageData);
```

### 3. Agent Receives Message
```javascript
// Agent's MessageBusService handles it
async handleIncomingMessage(message) {
  // Validate participation
  const participants = await this.getChannelParticipants(message.channel_id);
  if (!participants.includes(this.runtime.agentId)) return;
  
  // Create agent-specific representations
  const agentWorldId = createUniqueUuid(this.runtime, message.server_id);
  const agentRoomId = createUniqueUuid(this.runtime, message.channel_id);
  
  // Create agent memory from central message
  const agentMemory = this.createAgentMemory(
    message,
    agentAuthorEntityId,
    agentRoomId,
    agentWorldId
  );
  
  // Process with callback for response
  const callback = async (responseContent) => {
    // Store agent's response in its memory
    await this.runtime.createMemory({
      entityId: this.runtime.agentId,
      content: responseContent,
      roomId: agentRoomId,
      worldId: agentWorldId,
      agentId: this.runtime.agentId,
    }, 'messages');
    
    // Send to central system if not IGNOREd
    if (!responseContent.actions?.includes('IGNORE') && responseContent.text) {
      await this.sendAgentResponseToBus(
        agentRoomId,
        agentWorldId,
        responseContent,
        agentMemory.id,
        message
      );
    }
    
    return [];
  };
  
  await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
    runtime: this.runtime,
    message: agentMemory,
    callback: callback,
    onComplete: async () => {
      // Notify completion
      await this.notifyMessageComplete(message.channel_id, message.server_id);
    }
  });
}
```

### 4. Agent Responds
```javascript
// Agent sends response back (already processed, not for bus)
await fetch('/api/messaging/submit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    channel_id: 'channel-123',
    server_id: '00000000-0000-0000-0000-000000000000',
    author_id: agentId,
    content: 'The weather today is sunny with a high of 72°F.',
    source_type: 'agent_response',
    raw_message: {
      text: 'The weather today is sunny with a high of 72°F.',
      thought: 'User asked about weather, providing current conditions',
      actions: ['RESPOND']
    },
    in_reply_to_message_id: originalMessageId,
    metadata: { 
      agentName: 'WeatherBot',
      agent_name: 'WeatherBot' // Some parts expect this format
    }
  })
});
// This will NOT publish to the message bus - it's already processed
```

## Best Practices

### 1. Channel Management
- Create channels for logical conversation groupings
- Add agents to channels before expecting responses
- Use DM channels for 1-on-1 conversations
- Remember: Each agent maintains its own unique view of shared channels

### 2. Memory Considerations
- Agents create unique UUIDs for shared entities
- Original message IDs are preserved in metadata
- Each agent has its own memory database
- Memory queries are agent-specific

### 2. Server Organization
- Use the default server ID for simple deployments
- Create custom servers for multi-tenant applications
- Ensure agents are subscribed to relevant servers

### 3. Message Metadata
- Include platform-specific data in metadata
- Add user display names for better UX
- Preserve original message IDs for tracking

### 4. Error Handling
- Always validate UUIDs before submission
- Handle rate limiting gracefully
- Implement retry logic for transient failures

### 5. Scaling Considerations
- The in-memory bus works for single-process deployments
- For multi-process: Replace with Redis Pub/Sub
- For high scale: Consider Kafka or RabbitMQ

## Troubleshooting

### Agent Not Responding
1. Check agent is running and connected
2. Verify agent is participant in the channel
3. Confirm agent is subscribed to the server
4. Check message validation logs

### Messages Not Delivered
1. Verify all required fields are present
2. Check UUID formats are valid
3. Ensure database connection is healthy
4. Monitor message bus events

### Real-time Updates Not Working
1. Confirm Socket.IO connection is established
2. Check client has joined the correct channel
3. Verify no firewall/proxy issues
4. Monitor Socket.IO event logs

## Migration from Direct Messaging

If migrating from direct agent messaging:

1. **Identify Channels**: Create channels for existing conversations
2. **Add Participants**: Ensure agents are added to channels
3. **Update Endpoints**: Change from `/api/agents/{id}/message` to `/api/messaging/ingest-external` for user messages
4. **Include Server ID**: Use default server or create custom servers
5. **Handle Responses**: Agent responses go through `/api/messaging/submit`
6. **Test Thoroughly**: Verify message flow and agent responses

## Security Considerations

1. **Authentication**: Implement proper auth for message submission
2. **Authorization**: Validate user permissions for channels
3. **Rate Limiting**: Prevent message flooding
4. **Input Validation**: Sanitize message content
5. **Audit Logging**: Track message flow for compliance

## Conclusion

The centralized messaging system provides a robust, scalable foundation for multi-agent communication in ElizaOS. By decoupling message submission from agent-specific endpoints, the system enables flexible routing, better scalability, and support for complex multi-agent scenarios.