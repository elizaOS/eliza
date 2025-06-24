# @elizaos/api-client

Type-safe API client for ElizaOS server.

## Installation

```bash
bun add @elizaos/api-client
```

## Usage

```typescript
import { ElizaClient } from '@elizaos/api-client';

// Create client instance
const client = ElizaClient.create({
  baseUrl: 'http://localhost:3000',
  apiKey: 'your-api-key', // optional
});

// List all agents
const { agents } = await client.agents.listAgents();

// Create a new agent
const agent = await client.agents.createAgent({
  name: 'My Agent',
  description: 'A helpful assistant',
});

// Send a message
const message = await client.messaging.postMessage(channelId, 'Hello, world!');

// Upload media
const upload = await client.media.uploadAgentMedia(agentId, {
  file: myFile,
  filename: 'image.png',
});
```

## API Domains

### Agents

- CRUD operations for agents
- Agent lifecycle management (start/stop)
- World management
- Plugin panels and logs

### Messaging

- Message submission and management
- Channel operations
- Server management
- Message search

### Memory

- Agent memory management
- Room operations
- World management

### Audio

- Speech processing
- Text-to-speech
- Audio transcription

### Media

- File uploads for agents and channels

### Server

- Health checks and status
- Runtime debugging
- Log management

### System

- Environment configuration

## Error Handling

```typescript
import { ApiError } from '@elizaos/api-client';

try {
  await client.agents.getAgent(agentId);
} catch (error) {
  if (error instanceof ApiError) {
    console.error(`Error ${error.code}: ${error.message}`);
    if (error.details) {
      console.error('Details:', error.details);
    }
  }
}
```

## TypeScript Support

This package is written in TypeScript and provides full type definitions for all API endpoints, request parameters, and responses.
