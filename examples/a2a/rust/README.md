# elizaOS A2A Agent Server - Rust

An HTTP server that exposes an elizaOS agent for agent-to-agent communication using Rust and Axum.

## Requirements

- Rust 1.70+
- Optional: OpenAI API key (enables OpenAI-backed responses)

## Setup

```bash
# Optional: enable OpenAI-backed responses
export OPENAI_API_KEY=your-api-key
```

## Usage

```bash
# Build and run
cargo run --release
```

The server runs on `http://localhost:3000` by default.

## Building

```bash
cargo build --release
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
- `OPENAI_API_KEY` - OpenAI API key (optional)
- `OPENAI_BASE_URL` - Custom OpenAI endpoint

When `OPENAI_API_KEY` is not set, the server uses `@elizaos/plugin-inmemorydb` (ephemeral) + `elizaos-plugin-eliza-classic` so it can run deterministically without external services.
