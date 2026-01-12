# elizaOS Cloudflare Workers

Serverless AI agents running on Cloudflare Workers, powered by elizaOS.

## Overview

This example demonstrates how to deploy an AI chat agent to Cloudflare Workers in **three languages**:

| Language       | Directory          | Port | Description                                   |
| -------------- | ------------------ | ---- | --------------------------------------------- |
| **TypeScript** | `./` (root)        | 8787 | Primary implementation with streaming support |
| **Rust**       | `./rust-worker/`   | 8788 | High-performance WASM implementation          |
| **Python**     | `./python-worker/` | 8789 | Python (beta) implementation                  |

All implementations provide a REST API for chat interactions with support for:

- **Regular chat**: Send a message, get a complete response
- **Streaming chat**: Real-time token-by-token responses (TypeScript only)
- **Conversation memory**: Maintains context across multiple messages
- **Customizable character**: Configure name, bio, and system prompt

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ or [Bun](https://bun.sh/)
- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- OpenAI API key

## Quick Start

### 1. Install Dependencies

```bash
cd examples/cloudflare
bun install
# or: npm install
```

### 2. Set Your OpenAI API Key

For local development:

```bash
export OPENAI_API_KEY=your_key_here
```

For deployment, set it as a secret:

```bash
wrangler secret put OPENAI_API_KEY
# Enter your API key when prompted
```

### 3. Start Local Development Server

```bash
bun run dev
# or: npx wrangler dev
```

The worker will start at `http://localhost:8787`.

### 4. Test the Worker

In a new terminal:

```bash
# Interactive chat (regular mode)
bun run test

# Interactive chat (streaming mode)
bun run test:stream
```

Or use curl:

```bash
# Info endpoint
curl http://localhost:8787

# Health check
curl http://localhost:8787/health

# Send a message
curl -X POST http://localhost:8787/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, who are you?"}'

# Continue conversation
curl -X POST http://localhost:8787/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What can you help me with?", "conversationId": "YOUR_CONVERSATION_ID"}'
```

## Deployment

### Deploy to Cloudflare Workers

```bash
# Set the API key as a secret (first time only)
bun run secret
# or: wrangler secret put OPENAI_API_KEY

# Deploy to production
bun run deploy
# or: wrangler deploy
```

Your worker will be available at `https://elizaos-worker.<your-subdomain>.workers.dev`.

### Environment-Specific Deployment

```bash
# Deploy to staging
bun run deploy:staging

# Deploy to production
bun run deploy:production
```

## API Reference

### `GET /`

Returns information about the worker and character.

**Response:**

```json
{
  "name": "Eliza",
  "bio": "A helpful AI assistant powered by elizaOS.",
  "version": "2.0.0",
  "powered_by": "elizaOS",
  "endpoints": {
    "POST /chat": "Send a message and receive a response",
    "POST /chat/stream": "Send a message and receive a streaming response",
    "GET /health": "Health check endpoint",
    "GET /": "This info endpoint"
  }
}
```

### `GET /health`

Health check endpoint.

**Response:**

```json
{
  "status": "healthy",
  "character": "Eliza",
  "activeConversations": 5,
  "timestamp": "2024-01-10T12:00:00.000Z"
}
```

### `POST /chat`

Send a message and receive a complete response.

**Request:**

```json
{
  "message": "Hello!",
  "conversationId": "optional-uuid"
}
```

**Response:**

```json
{
  "response": "Hello! I'm Eliza, a helpful AI assistant. How can I help you today?",
  "conversationId": "abc123-...",
  "character": "Eliza"
}
```

### `POST /chat/stream`

Send a message and receive a streaming response via Server-Sent Events.

**Request:**

```json
{
  "message": "Tell me a story",
  "conversationId": "optional-uuid"
}
```

**Response (SSE):**

```
data: {"conversationId": "abc123-...", "character": "Eliza"}

data: {"text": "Once"}

data: {"text": " upon"}

data: {"text": " a"}

data: {"text": " time"}

data: [DONE]
```

## Configuration

### Environment Variables

| Variable           | Default                     | Description         |
| ------------------ | --------------------------- | ------------------- |
| `OPENAI_API_KEY`   | (required)                  | Your OpenAI API key |
| `OPENAI_BASE_URL`  | `https://api.openai.com/v1` | OpenAI API base URL |
| `OPENAI_MODEL`     | `gpt-5-mini`                | Model to use        |
| `CHARACTER_NAME`   | `Eliza`                     | Character name      |
| `CHARACTER_BIO`    | (default bio)               | Character biography |
| `CHARACTER_SYSTEM` | (default system)            | System prompt       |

### Customizing the Character

Edit `wrangler.toml`:

```toml
[vars]
CHARACTER_NAME = "MyAgent"
CHARACTER_BIO = "A specialized assistant for coding help."
CHARACTER_SYSTEM = "You are MyAgent, an expert programmer. Help users with coding questions."
OPENAI_MODEL = "gpt-5"
```

### Using Different LLM Providers

The worker is compatible with any OpenAI-compatible API. Set the base URL:

```toml
[vars]
OPENAI_BASE_URL = "https://api.together.xyz/v1"
OPENAI_MODEL = "meta-llama/Llama-3-70b-chat-hf"
```

Remember to set the appropriate API key:

```bash
wrangler secret put OPENAI_API_KEY
# Enter your Together AI / other provider API key
```

## Project Structure

```
examples/cloudflare/
├── src/
│   └── worker.ts           # TypeScript worker code
├── rust-worker/
│   ├── src/
│   │   └── lib.rs          # Rust worker code
│   ├── Cargo.toml          # Rust dependencies
│   ├── wrangler.toml       # Rust wrangler config
│   └── README.md           # Rust-specific docs
├── python-worker/
│   ├── src/
│   │   └── entry.py        # Python worker code
│   ├── wrangler.toml       # Python wrangler config
│   └── README.md           # Python-specific docs
├── test-client.ts          # Interactive test client
├── wrangler.toml           # TypeScript wrangler config
├── package.json            # Dependencies and scripts
├── tsconfig.json           # TypeScript configuration
└── README.md               # This file
```

## Multi-Language Examples

### TypeScript (Primary)

The TypeScript implementation is the most full-featured, with streaming support.

```bash
cd examples/cloudflare
bun install
bun run dev
```

### Rust

High-performance implementation using workers-rs, compiled to WASM.

```bash
cd examples/cloudflare/rust-worker
cargo install worker-build
wrangler dev
```

### Python

Python implementation using Cloudflare's Python Workers (beta).

```bash
cd examples/cloudflare/python-worker
wrangler dev
```

## Monitoring

### View Logs

```bash
# Real-time logs
bun run tail
# or: wrangler tail
```

### Cloudflare Dashboard

Visit [Cloudflare Workers Dashboard](https://dash.cloudflare.com/?to=/:account/workers) to view:

- Request metrics
- Error rates
- CPU time usage
- Logs and traces

## Production Considerations

### Conversation Storage

The default implementation stores conversations in memory, which:

- ✅ Works for development and light usage
- ❌ Loses data on worker restart
- ❌ Doesn't scale across multiple workers

For production, consider using:

1. **Cloudflare KV**: For simple key-value storage
2. **Cloudflare Durable Objects**: For stateful, consistent storage
3. **Cloudflare D1**: For SQL database storage

### Rate Limiting

Add rate limiting for production:

```toml
# wrangler.toml
[[rate_limiting]]
simple = { limit = 100, period = 60 }
```

### Custom Domain

Add a custom domain in your Cloudflare dashboard or:

```toml
# wrangler.toml
routes = [
  { pattern = "api.yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

## Troubleshooting

### "OPENAI_API_KEY is not configured"

Set the secret:

```bash
wrangler secret put OPENAI_API_KEY
```

### Worker not responding

Check logs:

```bash
wrangler tail
```

### CORS errors in browser

The worker includes CORS headers. If you still have issues, verify the request method is allowed.

## Related Examples

- [`../typescript/`](../typescript/) - Node.js/Bun CLI examples
- [`../python/`](../python/) - Python examples
- [`../rust/`](../rust/) - Pure Rust examples

## License

MIT
