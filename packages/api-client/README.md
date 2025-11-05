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

// Create a session for user-agent conversation
const session = await client.sessions.createSession({
  agentId: agent.id,
  userId: 'user-123',
  metadata: { platform: 'web' },
});

// Send a message in the session
const sessionMessage = await client.sessions.sendMessage(session.sessionId, {
  content: 'Hello, agent!',
});

// Upload media
const upload = await client.media.uploadAgentMedia(agentId, {
  file: myFile,
  filename: 'image.png',
});

// Quick one-off message with automatic polling (Jobs API)
const response = await client.jobs.ask('user-123', 'What is Bitcoin?');
console.log('Agent response:', response);
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

### Sessions

- Create and manage user-agent conversation sessions
- Send and retrieve messages within sessions
- Session metadata and lifecycle management
- Automatic cleanup of inactive sessions

### Jobs

- One-off messaging with automatic response handling
- Simple request/response pattern for agent interactions
- Automatic polling with customizable strategies
- Job status tracking and health metrics

Example:
```typescript
// Simple ask pattern - returns the response directly
const response = await client.jobs.ask('user-id', 'What is Bitcoin?');

// Create and poll manually for more control
const result = await client.jobs.createAndPoll({
  userId: 'user-id',
  content: 'Complex analysis query',
  agentId: 'specific-agent-id', // Optional
  timeoutMs: 60000, // Optional
});

if (result.success) {
  console.log('Response:', result.job.result?.message.content);
  console.log('Processing time:', result.job.result?.processingTimeMs, 'ms');
}

// Poll with exponential backoff for long-running queries
const backoffResult = await client.jobs.createAndPollWithBackoff({
  userId: 'user-id',
  content: 'Long running task',
}, {
  initialInterval: 500,
  maxInterval: 5000,
  multiplier: 1.5,
});

// Get job status manually
const job = await client.jobs.getJob('job-id');
console.log('Status:', job.status);

// List all jobs
const { jobs } = await client.jobs.list({ 
  status: JobStatus.COMPLETED,
  limit: 10 
});

// Check health metrics
const health = await client.jobs.health();
console.log('Success rate:', health.metrics.successRate);
```

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
