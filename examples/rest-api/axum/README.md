# elizaOS REST API - Axum

A simple REST API server for chatting with an elizaOS agent using Axum.

**No API keys or external services required!** Uses:

- `plugin-eliza-classic` for pattern-matching responses (no LLM needed)

## Quick Start

```bash
# Build and run
cargo run --release

# Or with hot-reload (requires cargo-watch)
cargo watch -x run
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
PORT=8080 cargo run --release
```

## Why Axum?

Axum is a modern, ergonomic web framework built on Tokio and Tower:

- Type-safe extractors and handlers
- Seamless integration with the Tower ecosystem
- Excellent async support
- Built by the Tokio team



