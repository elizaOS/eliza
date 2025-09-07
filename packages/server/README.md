# @elizaos/server

The server package provides the REST API and WebSocket server infrastructure for ElizaOS agents. It's the core runtime server that powers the ElizaOS CLI and can be embedded in other applications.

## Overview

`@elizaos/server` exports a complete agent server implementation including:

- REST API endpoints for agent management and interaction
- WebSocket support for real-time communication
- Database integration with SQLite/PostgreSQL
- Plugin system integration
- Multi-agent runtime management
- Built-in web UI serving (client bundled with server)

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
import { AgentServer } from '@elizaos/server';

// Create and initialize server
const server = new AgentServer();
await server.initialize();

// Start the server
const port = 3000;
server.start(port);

// Server is now running at http://localhost:3000
```

### Advanced Configuration

```typescript
import { AgentServer, ServerOptions, ServerMiddleware } from '@elizaos/server';
import { logger } from '@elizaos/core';

// Custom middleware
const customMiddleware: ServerMiddleware = (req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
};

// Server configuration
const serverOptions: ServerOptions = {
  dataDir: './data/agents',
  middlewares: [customMiddleware],
  postgresUrl: process.env.DATABASE_URL, // Optional PostgreSQL
};

// Initialize server with options
const server = new AgentServer();
await server.initialize(serverOptions);

// Register additional middleware
server.registerMiddleware((req, res, next) => {
  res.setHeader('X-Server', 'ElizaOS');
  next();
});

// Start the server
server.start(3000);
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
import { AgentServer } from '@elizaos/server';

const app = express();

// Create ElizaOS server
const elizaServer = new AgentServer();
await elizaServer.initialize();

// Mount ElizaOS APIs on your Express app
// The server provides its own Express app instance
app.use('/eliza', elizaServer.app);

// Your custom routes
app.get('/custom', (req, res) => {
  res.json({ message: 'Custom endpoint' });
});

app.listen(3000);
```

### Programmatic Agent Management

```typescript
import { AgentServer } from '@elizaos/server';
import { AgentRuntime, Character } from '@elizaos/core';

// Initialize server
const server = new AgentServer();
await server.initialize();

// Create and register agent runtime
const character: Character = {
  name: 'MyAgent',
  // ... character configuration
};

// Note: Full AgentRuntime creation requires more setup
// This is a simplified example
const runtime = new AgentRuntime({
  character,
  database: server.database,
  // ... other configuration
});

// Register agent with server
await server.registerAgent(runtime);

// Start server
server.start(3000);
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

## Client Integration

The server package includes the ElizaOS web client UI. During the build process:

1. The client package (`@elizaos/client`) is built separately
2. The server build script copies the client dist files to `server/dist/client`
3. The server serves these files automatically when the web UI is enabled

### Building with Client

```bash
# Build client first
cd packages/client
bun run build

# Then build server (automatically includes client)
cd ../server
bun run build
```

The server looks for client files in these locations (in order):

1. `dist/client` - Bundled client files (production)
2. `../client/dist` - Direct client build (development)
3. Via `@elizaos/client` package resolution

### Disabling Web UI

To run the server without the web UI:

```bash
DISABLE_WEB_UI=true npm start
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
