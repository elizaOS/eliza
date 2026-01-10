# ELIZA - elizaOS 2.0 Browser Demo

A demonstration of the full **elizaOS 2.0 runtime** running entirely in the browser with:

- **AgentRuntime** - Full elizaOS agent runtime
- **PGLite** - In-browser PostgreSQL via WebAssembly
- **Classic ELIZA Plugin** - Pattern matching responses (no LLM required)
- **Bootstrap Plugin** - Core agent functionality

This demo mirrors the structure of `examples/chat/typescript/chat.ts` but runs in the browser with a custom ELIZA plugin instead of OpenAI.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser Environment                     │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐    │
│  │                   AgentRuntime                       │    │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │    │
│  │  │ ELIZA Plugin │  │ SQL Plugin   │  │ Bootstrap  │  │    │
│  │  │ (responses)  │  │ (PGLite)     │  │ (core)     │  │    │
│  │  └─────────────┘  └──────────────┘  └────────────┘  │    │
│  └─────────────────────────────────────────────────────┘    │
│                              │                               │
│                    messageService.handleMessage()            │
│                              │                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │               PGLite (PostgreSQL WASM)               │    │
│  │                   In-Memory Database                 │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# From monorepo root
cd examples/html
bun install
bun run dev
```

Then open http://localhost:3000

## Files

| File | Description |
|------|-------------|
| `src/main.ts` | Main application - mirrors chat.ts structure |
| `src/eliza-plugin.ts` | Classic ELIZA pattern matching plugin |
| `index.html` | Retro CRT terminal UI |

## How It Works

### 1. Runtime Initialization (same as chat.ts)

```typescript
const runtime = new AgentRuntime({
  character,
  plugins: [sqlPlugin, bootstrapPlugin, elizaPlugin],
});
await runtime.initialize();
```

### 2. Connection Setup (same as chat.ts)

```typescript
await runtime.ensureConnection({
  entityId: userId,
  roomId,
  worldId,
  userName: "User",
  source: "browser",
  channelId: "chat",
  serverId: "browser-server",
  type: ChannelType.DM,
});
```

### 3. Message Handling (same as chat.ts)

```typescript
const message = createMessageMemory({
  id: uuidv4() as UUID,
  entityId: userId,
  roomId,
  content: { text },
});

await runtime.messageService!.handleMessage(runtime, message, async (content) => {
  if (content?.text) {
    response += content.text;
  }
  return [];
});
```

## ELIZA Plugin

The ELIZA plugin registers handlers for:

- `TEXT_SMALL` - Pattern matching responses
- `TEXT_LARGE` - Pattern matching responses  
- `TEXT_EMBEDDING` - Deterministic pseudo-embeddings

This replaces the OpenAI plugin used in chat.ts, demonstrating that elizaOS can run with any model provider - including pure pattern matching!

## About ELIZA

ELIZA was created by Joseph Weizenbaum at MIT in 1966. It simulated a Rogerian psychotherapist using:

1. **Keyword Detection** - Finding important words in input
2. **Pattern Decomposition** - Matching input against regex patterns
3. **Response Reassembly** - Filling templates with reflected pronouns
4. **Weighted Priorities** - Choosing the most relevant response

This demo faithfully implements the original algorithm while running on modern elizaOS infrastructure.

## License

MIT
