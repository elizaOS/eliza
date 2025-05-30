# API Testing Guide

## Overview

This guide covers the API testing infrastructure for the Eliza central message server. The test suite validates all critical API endpoints including message submission, retrieval, channel management, and agent interactions.

## Running Tests

### Quick Start

```bash
# From the CLI package directory
npx tsx src/server/test/api-routes.test.ts

# Or use the shell script
./src/server/test/run-api-tests.sh
```

## Test Coverage

The test suite covers the following endpoints:

### Basic API Endpoints

- `GET /api/hello` - Basic health check
- `GET /api/status` - Server status with agent count
- `GET /api/ping` - Server ping

### Message Server Endpoints

- `GET /api/messages/central-servers` - List all servers
- `POST /api/messages/servers` - Create a new server
- `GET /api/messages/central-servers/:serverId/channels` - List channels for a server

### Channel Management

- `POST /api/messages/channels` - Create a new channel
- `GET /api/messages/central-channels/:channelId/details` - Get channel details
- `GET /api/messages/central-channels/:channelId/participants` - Get channel participants
- `POST /api/messages/central-channels` - Create group channel with participants
- `GET /api/messages/dm-channel` - Create or find DM channel

### Message Operations

- `POST /api/messages/submit` - Submit a message to central store
- `GET /api/messages/central-channels/:channelId/messages` - Get messages for a channel
- `DELETE /api/messages/central-channels/:channelId/messages/:messageId` - Delete a message
- `DELETE /api/messages/central-channels/:channelId/messages` - Clear all messages in channel

### Agent Integration

- `POST /api/agents/:agentId/message` - Send direct message to agent via central store

## Key Fixes Applied

### 1. Body Parser Import

Fixed the body-parser import in both `index.ts` and `api/index.ts`:

```typescript
// Before
import * as bodyParser from 'body-parser';

// After
import bodyParser from 'body-parser';
```

### 2. Missing API Endpoints

Added missing endpoints to `messages.ts`:

- `POST /api/messages/servers` - Create central server
- `POST /api/messages/channels` - Create central channel

### 3. TypeScript Errors

Fixed TypeScript errors in message router by adding `@ts-expect-error` comments for valid Express routes that TypeScript couldn't properly type.

### 4. Test Infrastructure

Created a comprehensive test file that:

- Initializes a test server with central database
- Creates a test agent with SQL plugin
- Tests all API endpoints in sequence
- Properly cleans up resources after testing

## Architecture Validation

The tests validate the following architectural requirements:

### Central Message Store

- Messages are stored centrally in PGlite database
- Central database is separate from agent databases
- Messages flow through internal message bus

### ID Separation

- Central IDs (serverId, channelId) are used by the API
- Agent-specific IDs (worldId, roomId) are created by swizzling
- Proper mapping between central and agent-specific IDs

### Message Flow

1. GUI/External → Central API → Central DB → Internal Bus → Agents
2. Agent responses → Central API → Central DB → GUI/External

## Error Handling

The test suite includes proper error handling:

- Invalid UUID validation
- Missing required fields
- 404 for non-existent resources
- Graceful server shutdown

## Future Improvements

1. Add authentication tests when `ELIZA_SERVER_AUTH_TOKEN` is set
2. Add concurrent message handling tests
3. Add stress testing for high message volumes
4. Add WebSocket/SocketIO integration tests
5. Add tests for message pagination and filtering
