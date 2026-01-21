# elizaOS A2A (Agent-to-Agent) Server Examples

This directory contains A2A (Agent-to-Agent) server implementations that expose an elizaOS agent as an HTTP server. This enables agent-to-agent communication, webhooks, and integration with other AI systems.

**Uses real elizaOS runtime.**

- If `OPENAI_API_KEY` is set, the server will use an OpenAI-backed model (and SQL where supported).
- If `OPENAI_API_KEY` is not set, the server runs in a deterministic “ELIZA classic” mode (no API keys required), backed by `@elizaos/plugin-inmemorydb` for ephemeral multi-turn state.

## Available Examples

| Framework                   | Language   | Directory     |
| --------------------------- | ---------- | ------------- |
| [Express.js](./typescript/) | TypeScript | `typescript/` |
| [FastAPI](./python/)        | Python     | `python/`     |
| [Axum](./rust/)             | Rust       | `rust/`       |

## What is A2A?

A2A (Agent-to-Agent) is a pattern where AI agents communicate with each other over HTTP. Each agent exposes a simple API that allows:

- Sending messages to the agent
- Receiving responses
- Querying agent capabilities
- Multi-turn conversations with session management

## Common API Endpoints

All implementations expose the same REST API:

### `GET /`

Returns information about the agent.

```bash
curl http://localhost:3000/
```

Response:

```json
{
  "name": "Eliza",
  "bio": "A helpful AI assistant",
  "version": "2.0.0-alpha",
  "capabilities": ["chat", "reasoning", "tool-use"],
  "powered_by": "elizaOS"
}
```

### `GET /health`

Health check endpoint.

```bash
curl http://localhost:3000/health
```

### `POST /chat`

Send a message to the agent and receive a response.

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, how are you?", "sessionId": "user-123"}'
```

Response:

```json
{
  "response": "Hello! I'm doing well, thank you for asking. How can I help you today?",
  "agentId": "eliza-agent-id",
  "sessionId": "user-123",
  "timestamp": "2024-01-10T12:00:00Z"
}
```

### `POST /chat/stream`

Stream a response from the agent (SSE).

```bash
curl -X POST http://localhost:3000/chat/stream \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"message": "Tell me a story"}'
```

## Quick Start

### TypeScript

```bash
cd typescript
bun install
bun run start
```

### Python

```bash
cd python
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python server.py
```

### Rust

```bash
cd rust
cargo run --release
```

## Configuration

Optional: OpenAI API key (enables OpenAI-backed responses):

```bash
export OPENAI_API_KEY=your-key
```

Optional configuration:

- `PORT` - Server port (default: 3000)
- `OPENAI_BASE_URL` - Custom OpenAI-compatible endpoint
- `OPENAI_SMALL_MODEL` - Model for quick responses
- `OPENAI_LARGE_MODEL` - Model for complex responses

## Use Cases

1. **Multi-Agent Systems**: Have multiple agents communicate with each other
2. **Webhooks**: Receive events from external services and have the agent respond
3. **Chatbots**: Deploy agents as backend services for chat applications
4. **API Integration**: Integrate agents into existing API-based workflows
5. **Testing**: Test agent behavior programmatically

## Testing

Each implementation includes a test client:

```bash
# TypeScript
cd typescript && bun run test

# Python
cd python && python test_runner.py

# Rust
cd rust && cargo test
```

## Agent-to-Agent Communication Example

```bash
# Agent A calls Agent B
curl -X POST http://agent-b:3000/chat \
  -H "Content-Type: application/json" \
  -H "X-Agent-Id: agent-a" \
  -d '{
    "message": "Can you help me analyze this data?",
    "context": {"source": "agent-a", "task": "data-analysis"}
  }'
```
