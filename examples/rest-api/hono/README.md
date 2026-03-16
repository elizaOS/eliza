# elizaOS REST API - Hono

A simple REST API server for chatting with an elizaOS agent using Hono.

**No API keys or external services required!** Uses:

- `plugin-localdb` for local JSON-based storage
- `plugin-eliza-classic` for pattern-matching responses (no LLM needed)

## Quick Start

```bash
# Install dependencies
bun install

# Start the server
bun run start
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
  "response": "How do you do. Please state your problem.",
  "character": "Eliza",
  "userId": "generated-uuid"
}
```

## Configuration

Set the `PORT` environment variable to change the default port:

```bash
PORT=8080 bun run start
```



