# elizaOS REST API Examples

This directory contains REST API examples for elizaOS using various web frameworks across TypeScript, Python, and Rust.

All examples use the **canonical elizaOS implementation pattern**:

```
runtime.messageService.handleMessage(runtime, messageMemory, callback)
```

## The Canonical Pattern

Every example follows the same core pattern:

1. **Create an AgentRuntime** with plugins (sql, openai, etc.)
2. **Initialize the runtime** with `await runtime.initialize()`
3. **Ensure connection** for the user session
4. **Create a message memory** with the user's message
5. **Call `messageService.handleMessage()`** to process the message

### TypeScript Example

```typescript
import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  createMessageMemory,
  stringToUuid,
} from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import sqlPlugin from "@elizaos/plugin-sql";

// Create runtime
const runtime = new AgentRuntime({
  character: createCharacter({ name: "Eliza", bio: "A helpful AI assistant." }),
  plugins: [sqlPlugin, openaiPlugin],
});

await runtime.initialize();

// Handle a message
const messageMemory = createMessageMemory({
  id: uuidv4(),
  entityId: userId,
  roomId: stringToUuid("room"),
  content: { text: "Hello!", source: "api", channelType: ChannelType.API },
});

await runtime.messageService?.handleMessage(runtime, messageMemory, async (content) => {
  console.log("Response:", content.text);
  return [];
});
```

## Available Examples

| Framework             | Language   | Directory  | Full Runtime |
| --------------------- | ---------- | ---------- | ------------ |
| [Express](./express/) | TypeScript | `express/` | ✅ Yes       |
| [Hono](./hono/)       | TypeScript | `hono/`    | ✅ Yes       |
| [Elysia](./elysia/)   | TypeScript | `elysia/`  | ✅ Yes       |
| [FastAPI](./fastapi/) | Python     | `fastapi/` | ✅ Yes       |
| [Flask](./flask/)     | Python     | `flask/`   | ✅ Yes       |
| [Actix Web](./actix/) | Rust       | `actix/`   | ✅ Yes       |
| [Axum](./axum/)       | Rust       | `axum/`    | ✅ Yes       |
| [Rocket](./rocket/)   | Rust       | `rocket/`  | ✅ Yes       |

## Common API

All examples expose the same REST API:

### `GET /`

Returns information about the agent.

```bash
curl http://localhost:3000/
```

### `GET /health`

Health check endpoint.

```bash
curl http://localhost:3000/health
```

### `POST /chat`

Send a message to the agent.

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, how are you?"}'
```

Response:

```json
{
  "response": "Hello! I'm doing well. How can I help you today?",
  "character": "Eliza",
  "userId": "generated-uuid"
}
```

### `POST /chat/stream` (TypeScript only)

Send a message and receive a streaming response via Server-Sent Events.

```bash
curl -X POST http://localhost:3000/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"message": "Tell me a story"}'
```

## Quick Start

### TypeScript (Express, Hono, Elysia)

```bash
cd express  # or hono, elysia
bun install
OPENAI_API_KEY=your-key bun run start
```

### Python (FastAPI, Flask)

```bash
cd fastapi  # or flask
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
OPENAI_API_KEY=your-key python server.py
```

### Rust (Actix, Axum, Rocket)

```bash
cd actix  # or axum, rocket
OPENAI_API_KEY=your-key cargo run --release
```

## Environment Variables

| Variable         | Description             | Required |
| ---------------- | ----------------------- | -------- |
| `OPENAI_API_KEY` | OpenAI API key          | Yes      |
| `PORT`           | Server port (default: 3000) | No   |
| `CHARACTER_NAME` | Agent name              | No       |
| `CHARACTER_BIO`  | Agent bio/description   | No       |

## Important: Never Call Plugins Directly

**DO NOT** do this:

```typescript
// ❌ WRONG - Never call plugin functions directly
import { generateElizaResponse } from "@elizaos/plugin-eliza-classic";
const response = generateElizaResponse(message);
```

**DO** this instead:

```typescript
// ✅ CORRECT - Always use the runtime's message service
await runtime.messageService?.handleMessage(runtime, messageMemory, callback);
```

The message service:
- Manages conversation context and memory
- Runs evaluators to check if the agent should respond
- Invokes providers to gather context
- Executes actions based on the conversation
- Handles all model calls through the plugin system
