# @elizaos/server

The server package provides the REST API and WebSocket server infrastructure for ElizaOS agents. It's the core runtime server that powers the ElizaOS CLI and can be embedded in other applications.

## Overview

`@elizaos/server` exports a complete agent server implementation including:

- REST API endpoints for agent management and interaction
- WebSocket support for real-time communication
- JWT authentication with data isolation (Privy, Auth0, Clerk, Supabase, Google, custom)
- Database integration with SQLite/PostgreSQL
- Plugin system integration
- Multi-agent runtime management
- Built-in web UI serving (client bundled with server)

This package is used internally by the ElizaOS CLI (`@elizaos/cli`) but can also be imported directly to create custom server implementations.

## Installation

```bash
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

### Public Endpoints (Unauthenticated)

Health check endpoints for load balancers and monitoring (rate limited: 100 req/min):

- `GET /healthz` - Lightweight health check (always returns 200 OK)
- `GET /health` - Comprehensive health check (200 if healthy, 503 if no agents)

### Protected API Endpoints

The server provides a comprehensive REST API organized into functional categories:

### Agents (`/api/agents`)

Core agent management and operations:
- Agent CRUD (create, read, update, delete)
- Agent lifecycle (start, stop, restart)
- Agent memory and state
- Agent worlds and panels
- Agent logs and runs
- Room management

### Messaging (`/api/messaging`)

Real-time messaging infrastructure:
- Message operations
- Channel management
- Sessions handling
- Job queue

### Memory (`/api/memory`)

Persistent memory storage:
- Agent-specific memory
- Group memory
- Room context

### Media (`/api/media`)

File and media handling:
- Agent media (avatars, files)
- Channel media uploads

### Audio (`/api/audio`)

Voice and audio features:
- Audio processing
- Speech synthesis
- Audio conversations

### Authentication (`/api/auth`)

Credentials and authentication management

### System (`/api/system`)

- `GET /api/system/config` - Server configuration (JWT status, features)
- `GET /api/system/version` - Version information
- `GET /api/system/env` - Environment details

### Runtime (`/api/runtime`)

- `GET /api/runtime/health` - Health check
- `GET /api/runtime/logging` - Logging configuration
- `POST /api/runtime/debug` - Debug operations

> **Note:** For detailed endpoint documentation, see the API router files in `src/api/`

## WebSocket Events

Connect to `ws://localhost:3000/ws` for real-time communication:

```javascript
// Client-side WebSocket connection
const ws = new WebSocket('ws://localhost:3000');

// Connection established
ws.onopen = () => {
  console.log('Connected to server');
};

// Send message
ws.send(
  JSON.stringify({
    type: 'message',
    agentId: 'agent-123',
    content: 'Hello, agent!',
  })
);

// Receive responses
ws.onmessage = (event) => {
  const response = JSON.parse(event.data);
  console.log('Agent response:', response);
};
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
- `ENABLE_DATA_ISOLATION` - Enable JWT authentication and data isolation (true/false)
- `DISABLE_WEB_UI` - Disable the built-in web UI (true/false)

### JWT Authentication

Enable data isolation and authentication by setting `ENABLE_DATA_ISOLATION=true`. The server supports multiple JWT providers:

**Privy (Ed25519)**:
```bash
ENABLE_DATA_ISOLATION=true
PRIVY_VERIFICATION_KEY=-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA...
-----END PUBLIC KEY-----
```
Get key from: Privy Dashboard → Configuration → App settings

**JWKS Providers** (Auth0, Clerk, Supabase, Google):
```bash
ENABLE_DATA_ISOLATION=true
JWT_JWKS_URI=https://your-domain/.well-known/jwks.json
```

**Custom Secret** (HMAC):
```bash
ENABLE_DATA_ISOLATION=true
JWT_SECRET=your-256-bit-secret
```

**Optional:**
```bash
JWT_ISSUER_WHITELIST=https://auth.privy.io,https://clerk.your-app.com
```

The server automatically selects the appropriate verifier based on configuration (Ed25519 → JWKS → Secret priority).

### Error Monitoring (Sentry)

Set these to enable Sentry error reporting:

- `SENTRY_DSN` - Your Sentry DSN (enables Sentry when set)
- `SENTRY_ENVIRONMENT` - Environment name (e.g. `production`, `staging`, `development`)
- `SENTRY_TRACES_SAMPLE_RATE` - Number between 0 and 1 to enable tracing (optional; default 0)

When `SENTRY_DSN` is present, the server:

- Initializes Sentry during startup
- Captures API handler exceptions with route and request context
- Captures `uncaughtException` and `unhandledRejection` at the process level

Note: The server includes a default DSN that will be used if `SENTRY_DSN` is not set. To disable Sentry entirely, set `SENTRY_DSN` to an empty string.

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
├── api/                    # REST API route handlers
│   ├── agents/             # Agent management (CRUD, lifecycle, memory, logs, runs)
│   ├── messaging/          # Messaging infrastructure (channels, sessions, jobs)
│   ├── memory/             # Persistent memory (agents, groups, rooms)
│   ├── media/              # File and media handling
│   ├── audio/              # Voice and audio processing
│   ├── auth/               # Authentication and credentials
│   ├── system/             # System config, version, environment
│   ├── runtime/            # Health, logging, debug
│   ├── shared/             # Shared API utilities
│   └── tee/                # TEE (Trusted Execution Environment)
├── middleware/             # Express middleware
│   ├── jwt-auth.ts         # JWT authentication middleware
│   ├── api-key.ts          # API key validation
│   ├── rate-limit.ts       # Rate limiting
│   ├── security.ts         # Security headers (helmet, CORS)
│   └── validation.ts       # Request validation
├── services/               # Core services
│   ├── jwt-verifiers/      # JWT verification (Ed25519, JWKS, Secret)
│   └── message.ts          # Message processing service
├── socketio/               # WebSocket/Socket.IO implementation
├── utils/                  # Utility functions
└── index.ts                # Main exports and server setup
```

> **Note:** Database operations are handled by `@elizaos/core`

## Development

### Running Tests

```bash
# Run all tests (unit, features, security, compatibility)
bun test

# Run specific test suites
bun test:unit             # Unit tests only
bun test:features         # Feature tests only
bun test:security         # Security tests (RLS)
bun test:compatibility    # CLI/API compatibility tests
bun test:integration      # Integration tests (sequential via script)

# Run with coverage
bun test:coverage

# Watch mode for development
bun test:watch
```

**Note:** Integration tests run sequentially via `scripts/run-integration-tests.sh` due to PGLite's global singleton state. Each test file runs in an isolated Bun process with 5-second pauses between files.

For more details on the test architecture, see [src/__tests__/README.md](src/__tests__/README.md).

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
