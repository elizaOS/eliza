# elizaOS A2A Agent Server - TypeScript

An HTTP server that exposes an elizaOS agent for agent-to-agent communication using TypeScript and Express.

## Requirements

- Bun 1.0+ (or Node.js 18+)
- Optional: OpenAI API key (enables OpenAI-backed responses)

## Setup

```bash
# Install dependencies
bun install

# Optional: enable OpenAI-backed responses
export OPENAI_API_KEY=your-api-key
```

## Usage

```bash
# Start the server
bun run start
```

The server runs on `http://localhost:3000` by default.

## Testing

```bash
bun run test
```

`bun run test` starts the server on an ephemeral port, runs the test client, and shuts down (no separate server process required).

## API Endpoints

### `GET /`

Returns information about the agent.

### `GET /health`

Health check endpoint.

### `POST /chat`

Send a message to the agent.

**Request:**

```json
{
  "message": "Hello!",
  "sessionId": "optional-session-id"
}
```

**Response:**

```json
{
  "response": "Hello! How can I help you?",
  "agentId": "agent-uuid",
  "sessionId": "session-id",
  "timestamp": "2024-01-10T12:00:00Z"
}
```

### `POST /chat/stream`

Stream a response from the agent (Server-Sent Events).

## Configuration

- `PORT` - Server port (default: 3000)
- `OPENAI_API_KEY` - OpenAI API key (optional)
- `OPENAI_BASE_URL` - Custom OpenAI endpoint

When `OPENAI_API_KEY` is not set, the server uses `@elizaos/plugin-inmemorydb` + `@elizaos/plugin-eliza-classic` so it can run deterministically without external services.
