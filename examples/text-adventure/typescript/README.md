# TypeScript Examples

Pure TypeScript examples using elizaOS.

## Examples

| File                | Description                                         |
| ------------------- | --------------------------------------------------- |
| `chat.ts`           | Interactive CLI chat with an AI agent               |
| `adventure-game.ts` | Text adventure game with AI-powered decision making |

## Prerequisites

1. Build the project (from repo root):

   ```bash
   bun install
   bun run build
   ```

2. Set environment variables:
   ```bash
   export OPENAI_API_KEY=your_key_here
   ```

## Run

### Chat

```bash
bun run examples/typescript/chat.ts
```

### Adventure Game

```bash
# Normal mode
bun run examples/typescript/adventure-game.ts

# Suppress logs (recommended for cleaner output)
LOG_LEVEL=fatal bun run examples/typescript/adventure-game.ts

# With persistent storage
PGLITE_DATA_DIR=./adventure-db LOG_LEVEL=fatal bun run examples/typescript/adventure-game.ts
```

## Environment Variables

| Variable             | Default                     | Description                     |
| -------------------- | --------------------------- | ------------------------------- |
| `OPENAI_API_KEY`     | (required)                  | OpenAI API key                  |
| `OPENAI_BASE_URL`    | `https://api.openai.com/v1` | API base URL                    |
| `OPENAI_SMALL_MODEL` | `gpt-5-mini`                | Small model                     |
| `OPENAI_LARGE_MODEL` | `gpt-5`                     | Large model                     |
| `LOG_LEVEL`          | `info`                      | Set to `fatal` to suppress logs |
| `PGLITE_DATA_DIR`    | `memory://`                 | PGLite storage directory        |
| `POSTGRES_URL`       | (optional)                  | PostgreSQL connection string    |

## API Usage

### Chat Example

```typescript
import {
  AgentRuntime,
  ChannelType,
  createMessageMemory,
  stringToUuid,
  type Character,
  type UUID,
} from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";

// Create character and runtime
const character: Character = {
  name: "Eliza",
  bio: "A helpful AI assistant.",
};

const runtime = new AgentRuntime({
  character,
  plugins: [sqlPlugin, openaiPlugin],
});
await runtime.initialize();

// Handle messages
const message = createMessageMemory({
  id: uuidv4() as UUID,
  entityId: userId,
  roomId,
  content: { text: "Hello!" },
});

await runtime.messageService.handleMessage(
  runtime,
  message,
  async (content) => {
    if (content?.text) {
      console.log(content.text);
    }
    return [];
  },
);

// Cleanup
await runtime.stop();
```

### Adventure Game Example

```typescript
import { AgentRuntime, ModelType, stringToUuid } from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";

// Create runtime
const runtime = new AgentRuntime({
  character,
  plugins: [sqlPlugin, openaiPlugin],
  settings: {
    OPENAI_API_KEY: config.openaiApiKey,
    PGLITE_DATA_DIR: config.pgliteDataDir,
  },
});
await runtime.initialize();

// Use model directly for AI decisions
const response = await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt: "Choose an action...",
  maxTokens: 50,
  temperature: 0.3,
});
const chosenAction = String(response).trim();

// Cleanup
await runtime.stop();
```

## Features

### Chat

- Full conversation support with streaming responses
- Embedded database via PGLite
- Memory persistence across sessions

### Adventure Game

- 7 dungeon rooms to explore
- Items: torch, sword, golden key, health potions, treasure
- Enemies: goblin, skeleton, dragon (final boss)
- Two game modes:
  - **Watch AI Play**: Eliza makes all decisions autonomously
  - **Interactive**: Guide Eliza or play yourself

## Related Examples

- `../rust-wasm/` - TypeScript examples with optional Rust-WASM interop
- `../python/` - Python examples
- `../rust/` - Pure Rust examples
