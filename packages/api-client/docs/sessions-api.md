# Sessions API

The Sessions API provides a simplified interface for managing messaging sessions between users and agents. Sessions are temporary conversation contexts that maintain state and history for a specific user-agent interaction.

## Overview

Sessions provide:

- Dedicated conversation channels between users and agents
- Message history management
- Session metadata tracking
- Automatic cleanup of inactive sessions

## Usage

### Creating a Session

```typescript
import { ElizaClient } from '@elizaos/api-client';

const client = new ElizaClient({
  baseUrl: 'http://localhost:3000',
  apiKey: 'your-api-key',
});

// Create a new session
const session = await client.sessions.createSession({
  agentId: 'agent-uuid',
  userId: 'user-uuid',
  metadata: {
    platform: 'web',
    username: 'john_doe',
  },
});

console.log('Session ID:', session.sessionId);
```

### Sending Messages

```typescript
// Send a message in the session
const message = await client.sessions.sendMessage(session.sessionId, {
  content: 'Hello, how can you help me today?',
  attachments: [
    {
      type: 'image',
      url: 'https://example.com/image.jpg',
      name: 'screenshot.jpg',
    },
  ],
});

console.log('Message sent:', message.id);
```

### Retrieving Messages

```typescript
// Get recent messages
const messages = await client.sessions.getMessages(session.sessionId, {
  limit: 50,
});

console.log(`Retrieved ${messages.messages.length} messages`);
console.log('Has more:', messages.hasMore);

// Get messages before a specific date
const olderMessages = await client.sessions.getMessages(session.sessionId, {
  limit: 50,
  before: new Date('2024-01-01T00:00:00Z'),
});

// Get messages after a specific date
const newerMessages = await client.sessions.getMessages(session.sessionId, {
  limit: 50,
  after: new Date('2024-01-01T00:00:00Z'),
});
```

### Managing Sessions

```typescript
// Get session information
const sessionInfo = await client.sessions.getSession(session.sessionId);
console.log('Last activity:', sessionInfo.lastActivity);

// List all active sessions (admin)
const allSessions = await client.sessions.listSessions();
console.log(`Total active sessions: ${allSessions.total}`);

// Delete a session
await client.sessions.deleteSession(session.sessionId);
console.log('Session deleted');
```

### Health Check

```typescript
// Check sessions service health
const health = await client.sessions.checkHealth();
console.log(`Service status: ${health.status}`);
console.log(`Active sessions: ${health.activeSessions}`);
```

## Message Format

Messages in sessions include:

```typescript
interface SimplifiedMessage {
  id: string;
  content: string;
  authorId: string;
  isAgent: boolean; // true if message is from agent
  createdAt: Date;
  metadata: {
    thought?: string; // Agent's internal thought process
    actions?: string[]; // Actions taken by the agent
    [key: string]: any; // Additional metadata
  };
}
```

## Session Lifecycle

1. **Creation**: Sessions are created with `createSession`
2. **Active**: Messages can be sent and received
3. **Inactive**: No activity for extended period
4. **Cleanup**: Inactive sessions are automatically cleaned up after timeout

## Error Handling

```typescript
try {
  const session = await client.sessions.createSession({
    agentId: 'invalid-uuid',
    userId: 'user-uuid',
  });
} catch (error) {
  if (error instanceof ApiError) {
    console.error('API Error:', error.code, error.message);
  }
}
```

## Best Practices

1. **Session Reuse**: Don't create a new session for every message. Reuse sessions for ongoing conversations.

2. **Metadata**: Use metadata to store platform-specific information:

   ```typescript
   metadata: {
     platform: 'discord',
     channelId: 'discord-channel-id',
     guildId: 'discord-guild-id',
   }
   ```

3. **Pagination**: Use pagination when retrieving messages to avoid large responses:

   ```typescript
   let hasMore = true;
   let before = undefined;
   const allMessages = [];

   while (hasMore) {
     const response = await client.sessions.getMessages(sessionId, {
       limit: 100,
       before,
     });

     allMessages.push(...response.messages);
     hasMore = response.hasMore;

     if (response.messages.length > 0) {
       before = response.messages[response.messages.length - 1].createdAt;
     }
   }
   ```

4. **Error Recovery**: Implement retry logic for transient failures:
   ```typescript
   async function sendMessageWithRetry(
     sessionId: string,
     params: SendMessageParams,
     maxRetries = 3
   ) {
     for (let i = 0; i < maxRetries; i++) {
       try {
         return await client.sessions.sendMessage(sessionId, params);
       } catch (error) {
         if (i === maxRetries - 1) throw error;
         await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
       }
     }
   }
   ```

## Type Definitions

All types are exported from the package:

```typescript
import type {
  Session,
  SessionMetadata,
  CreateSessionParams,
  CreateSessionResponse,
  SendMessageParams,
  GetMessagesParams,
  GetMessagesResponse,
  SimplifiedMessage,
  SessionInfoResponse,
  SessionsHealthResponse,
  ListSessionsResponse,
  MessageResponse,
} from '@elizaos/api-client';
```
