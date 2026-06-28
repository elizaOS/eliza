# elizaOS REST API - Express.js

A simple REST API server for chatting with an elizaOS agent using Express.js.

Uses:

- `plugin-sql` with PGLite by default for local storage (no external DB needed)
- An LLM provider chosen by which API key env var is set, in priority order:
  `OPENAI_API_KEY` → `OPENROUTER_API_KEY` → `ANTHROPIC_API_KEY` → `ELIZA_API_KEY`.
  Set at least one before starting the server.

## Quick Start

```bash
# Install dependencies
bun install

# Start the server (set one inference provider key first)
OPENAI_API_KEY=sk-... bun run start
```

The server will start at http://localhost:3000

## API Endpoints

### GET /

Returns information about the agent.

```bash
curl http://localhost:3000/
```

### GET /health

Health check endpoint.

```bash
curl http://localhost:3000/health
```

### POST /chat

Send a message to the agent.

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, how are you?"}'
```

Response:

```json
{
  "response": "Hello! How can I help you today?",
  "character": "Eliza",
  "userId": "generated-uuid",
  "mode": "openai"
}
```

## Configuration

Set the `PORT` environment variable to change the default port:

```bash
PORT=8080 bun run start
```

## Validate

```bash
bun run test
bun run typecheck
```

The test suite imports the Express app without binding port 3000 and verifies
CORS plus request validation.
