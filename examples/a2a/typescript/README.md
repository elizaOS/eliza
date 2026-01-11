# elizaOS A2A Agent Server - TypeScript

An HTTP server that exposes an elizaOS agent for agent-to-agent communication using TypeScript and Express.

## Requirements

- Bun 1.0+ (or Node.js 18+)
- OpenAI API key

## Setup

```bash
# Install dependencies
bun install

# Set up environment
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
- `OPENAI_API_KEY` - OpenAI API key (required)
- `OPENAI_BASE_URL` - Custom OpenAI endpoint
