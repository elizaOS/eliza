# @elizaos/server

The server package provides the REST API and WebSocket server infrastructure for ElizaOS agents. It's the core runtime server that powers the ElizaOS CLI and can be embedded in other applications.

## Overview

`@elizaos/server` exports a complete agent server implementation including:

- REST API endpoints for agent management and interaction
- WebSocket support for real-time communication
- Database integration with SQLite/PostgreSQL
- Plugin system integration
- Multi-agent runtime management
- Built-in web UI serving

This package is used internally by the ElizaOS CLI (`@elizaos/cli`) but can also be imported directly to create custom server implementations.

## Installation

```bash
npm install @elizaos/server
# or
bun add @elizaos/server
```

## Usage

### Basic Server Setup

```typescript
import { createServer } from '@elizaos/server';

// Start the server with default configuration
const server = await createServer({
  port: 3000,
  agents: ['./characters/assistant.json'],
});

// Server is now running at http://localhost:3000
```

### Advanced Configuration

```typescript
import { AgentServer } from '@elizaos/server';
import { Character } from '@elizaos/core';

// Create custom character
const myCharacter: Character = {
  name: 'Assistant',
  system: 'You are a helpful assistant.',
  // ... other character config
};

// Initialize server with options
const server = new AgentServer({
  port: 3000,
  host: '0.0.0.0',
  cors: {
    origin: '*',
    credentials: true,
  },
});

// Add agents programmatically
await server.addAgent(myCharacter);

// Start the server
await server.start();
```

## API Endpoints

### Agent Management

- `GET /api/agents` - List all running agents
- `GET /api/agents/:agentId` - Get specific agent details
- `POST /api/agents` - Create new agent
- `PUT /api/agents/:agentId` - Update agent configuration
- `DELETE /api/agents/:agentId` - Stop and remove agent

### Agent Interaction

- `POST /api/agents/:agentId/message` - Send message to agent
- `GET /api/agents/:agentId/history` - Get conversation history
- `POST /api/agents/:agentId/action` - Trigger specific agent action

### Memory & State

- `GET /api/agents/:agentId/memory` - Get agent memory/knowledge
- `POST /api/agents/:agentId/memory` - Add to agent memory
- `DELETE /api/agents/:agentId/memory/:memoryId` - Remove memory

### System

- `GET /api/health` - Health check endpoint
- `GET /api/version` - Get server version info

## WebSocket Events

Connect to `ws://localhost:3000/ws` for real-time communication:

```javascript
// Client-side WebSocket connection
const ws = new WebSocket('ws://localhost:3000/ws');

// Send message
ws.send(
  JSON.stringify({
    type: 'message',
    agentId: 'agent-123',
    content: 'Hello, agent!',
  })
);

// Receive responses
ws.on('message', (data) => {
  const response = JSON.parse(data);
  console.log('Agent response:', response);
});
```

### WebSocket Message Types

- `message` - Send/receive chat messages
- `action` - Trigger agent actions
- `status` - Agent status updates
- `error` - Error notifications

## Programmatic Usage

### Embedding in Express App

```typescript
import express from 'express';
import { createAgentRouter } from '@elizaos/server';

const app = express();

// Add ElizaOS agent routes
const agentRouter = createAgentRouter({
  agents: ['./my-agent.json'],
  database: {
    type: 'sqlite',
    path: './data/agents.db',
  },
});

app.use('/api', agentRouter);

app.listen(3000);
```

### Custom Runtime Integration

```typescript
import { AgentRuntime } from '@elizaos/server';
import { SqliteAdapter } from '@elizaos/plugin-sql';

// Create custom runtime
const runtime = new AgentRuntime({
  database: new SqliteAdapter('./my-app.db'),
  plugins: [
    // Add your plugins
  ],
});

// Use runtime in your application
await runtime.initialize();
const response = await runtime.processMessage('Hello!');
```

## Configuration

### Environment Variables

The server respects these environment variables:

- `PORT` - Server port (default: 3000)
- `HOST` - Server host (default: localhost)
- `DATABASE_URL` - PostgreSQL connection string
- `SQLITE_PATH` - Path to SQLite database file
- `LOG_LEVEL` - Logging level (debug, info, warn, error)
- `CORS_ORIGIN` - CORS allowed origins

### Server Options

```typescript
interface ServerOptions {
  port?: number;
  host?: string;
  agents?: string[] | Character[];
  database?: DatabaseConfig;
  plugins?: Plugin[];
  cors?: CorsOptions;
  staticDir?: string;
  enableWebUI?: boolean;
}
```

## Architecture

The server package is structured as follows:

```
server/
├── api/              # REST API route handlers
│   ├── agents/       # Agent management endpoints
│   ├── memory/       # Memory/knowledge endpoints
│   └── system/       # System/health endpoints
├── database/         # Database adapters and migrations
├── services/         # Core services (runtime, storage)
├── socketio/         # WebSocket implementation
└── index.ts          # Main exports
```

## Development

### Running Tests

```bash
# Run all tests
npm test

# Run specific test suite
npm test -- api/agents

# Run with coverage
npm test -- --coverage
```

### Building

```bash
# Build the package
npm run build

# Watch mode for development
npm run dev
```

## Examples

See the `/examples` directory for complete examples:

- Basic server setup
- Multi-agent configuration
- Custom plugin integration
- Database configuration
- WebSocket chat client

## License

MIT
