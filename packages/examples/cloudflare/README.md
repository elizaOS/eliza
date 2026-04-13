# elizaOS Cloudflare Workers

Deploy elizaOS agents as serverless functions on Cloudflare Workers.

## Available Workers

| Worker            | Language   | Full Runtime | Notes                                                  |
| ----------------- | ---------- | ------------ | ------------------------------------------------------ |
| TypeScript        | TypeScript | ✅ Yes       | Recommended - uses full elizaOS runtime                |
| Python (Pyodide)  | Python     | ⚠️ Limited  | Uses direct API calls due to Pyodide constraints       |
| Rust (WASM)       | Rust       | ⚠️ Limited  | Uses direct API calls due to WASM constraints          |

## TypeScript Worker (Recommended)

The TypeScript worker uses the **canonical elizaOS implementation pattern**:

```typescript
// Create runtime with plugins
const runtime = new AgentRuntime({
  character,
  plugins: [openaiPlugin],
});
await runtime.initialize();

// Process messages through the message service
await runtime.messageService?.handleMessage(runtime, messageMemory, callback);
```

### Deployment

```bash
# Install dependencies
bun install

# Configure environment
cp wrangler.toml.example wrangler.toml
# Edit wrangler.toml and add your OPENAI_API_KEY

# Deploy
wrangler deploy
```

### Local Development

```bash
wrangler dev
```

## API Endpoints

All workers expose the same REST API:

### `GET /`

Returns information about the agent.

### `GET /health`

Health check endpoint.

### `POST /chat`

Send a message and receive a response.

```bash
curl -X POST https://your-worker.workers.dev/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!"}'
```

### `POST /chat/stream` (TypeScript only)

Send a message and receive a streaming response.

## Environment Variables

Configure these in your `wrangler.toml`:

```toml
[vars]
CHARACTER_NAME = "Eliza"
CHARACTER_BIO = "A helpful AI assistant"

[[secrets]]
OPENAI_API_KEY = "your-key"  # Use wrangler secret put OPENAI_API_KEY
```

## Limitations

### TypeScript Worker
- No persistent storage (PGLite not available in Workers)
- Runtime is initialized per-request
- For persistent state, use Cloudflare Durable Objects

### Python Worker (Pyodide)
- Cannot import the full `elizaos` package
- Uses direct OpenAI API calls
- For full Python runtime, deploy to a traditional server

### Rust Worker (WASM)
- WASM build may not support all runtime features
- Uses direct OpenAI API calls
- For full Rust runtime, deploy to a traditional server

## Production Recommendations

For production deployments:

1. **Use the TypeScript worker** for the best elizaOS integration
2. **Use Cloudflare KV or Durable Objects** for conversation state
3. **Set proper rate limits** in your wrangler.toml
4. **Monitor with Cloudflare Analytics**

## The Canonical Pattern

All workers should follow this pattern (where runtime is available):

```typescript
// 1. Create runtime with plugins
const runtime = new AgentRuntime({
  character,
  plugins: [openaiPlugin],
});

// 2. Initialize
await runtime.initialize();

// 3. Ensure connection
await runtime.ensureConnection({
  entityId: userId,
  roomId,
  worldId,
  userName: "User",
  source: "cloudflare",
  channelId: "worker-chat",
  type: ChannelType.API,
});

// 4. Create message memory
const messageMemory = createMessageMemory({
  id: uuidv4(),
  entityId: userId,
  roomId,
  content: { text: message, source: "cloudflare_worker" },
});

// 5. Process through message service
await runtime.messageService?.handleMessage(runtime, messageMemory, callback);
```
