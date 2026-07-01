# elizaOS REST API - Elysia

A simple REST API server for chatting with an elizaOS agent using Elysia (Bun's fast web framework).

**Set one inference provider API key.** The server picks a provider by which
env var is present, in priority order:

1. `OPENAI_API_KEY` → `@elizaos/plugin-openai`
2. `OPENROUTER_API_KEY` → `@elizaos/plugin-openrouter`
3. `ANTHROPIC_API_KEY` → `@elizaos/plugin-anthropic`
4. `ELIZA_API_KEY` → `@elizaos/plugin-elizacloud` (Eliza Cloud)

If none is set, startup fails with a clear error. Storage uses `plugin-sql`
with PGLite by default — no `POSTGRES_URL` required.

## Quick Start

```bash
# From the monorepo root, install dependencies
cd /path/to/eliza
bun install

# Provide one inference provider key (first one present wins)
export OPENAI_API_KEY=sk-...

# Start the server
bun run examples/rest-api/elysia/server.ts
```

> **Note**: This example must be run from the monorepo root to resolve workspace dependencies.

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

The `mode` field reports the selected provider
(`openai` / `openrouter` / `anthropic` / `elizacloud`).

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

The test suite imports the Elysia app without binding port 3000 and verifies
CORS plus request validation.

## Why Elysia?

Elysia is a fast, type-safe web framework designed for Bun. It provides:

- End-to-end type safety
- Automatic request validation
- High performance
- Excellent developer experience
