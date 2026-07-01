# elizaOS REST API - Hono

A simple REST API server for chatting with an elizaOS agent using Hono.

Uses:

- `plugin-sql` with PGLite by default for local storage (no external DB required)
- a real LLM provider, selected from the first API key that is set

## Inference provider

The server picks an inference provider from the first matching environment
variable, in priority order:

| Env var              | Provider plugin              | Reported `mode` |
| -------------------- | ---------------------------- | --------------- |
| `OPENAI_API_KEY`     | `@elizaos/plugin-openai`     | `openai`        |
| `OPENROUTER_API_KEY` | `@elizaos/plugin-openrouter` | `openrouter`    |
| `ANTHROPIC_API_KEY`  | `@elizaos/plugin-anthropic`  | `anthropic`     |
| `ELIZA_API_KEY`      | `@elizaos/plugin-elizacloud` | `elizacloud`    |

If none of these are set, the runtime fails to initialize and `/chat` returns a
`503` explaining that no inference provider is configured.

## Quick Start

```bash
# Install dependencies
bun install

# Set one inference provider key, then start the server
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

The test suite imports the Hono app without binding port 3000 and verifies CORS
plus request validation.
