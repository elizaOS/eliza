# ELIZA - elizaOS Browser Demo

A browser-based demo of the **full elizaOS AgentRuntime** using:

- **@elizaos/core** - AgentRuntime, ModelType
- **@elizaos/plugin-localdb** - localStorage persistence (no SQL needed)
- a **real inference provider**, chosen by which API key is configured —
  OpenAI → OpenRouter → Anthropic → Eliza Cloud (in priority order)

This demo mirrors the structure of `packages/examples/chat/chat.ts` exactly, but runs in the browser.

## Configure an inference provider

The demo needs exactly one inference provider. Set a key before the page loads
(for example from the browser console or a small boot script) and the runtime
picks the first one that is present, in priority order:

```js
globalThis.ELIZA_ENV = { OPENAI_API_KEY: "sk-..." };
// or OPENROUTER_API_KEY, or ANTHROPIC_API_KEY, or ELIZA_API_KEY
```

If none of `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, or
`ELIZA_API_KEY` is set, the demo throws a clear error instead of falling back to
an offline mode.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser Environment                     │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐    │
│  │                   AgentRuntime                       │    │
│  │  ┌──────────────────┐  ┌──────────────────────┐     │    │
│  │  │ inference        │  │  plugin-localdb      │     │    │
│  │  │ provider plugin  │  │  (localStorage)      │     │    │
│  │  │ (TEXT_LARGE)     │  │                      │     │    │
│  │  └──────────────────┘  └──────────────────────┘     │    │
│  └─────────────────────────────────────────────────────┘    │
│                              │                               │
│               runtime.messageService.handleMessage()         │
│                              │                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                    localStorage                       │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

**Important**: This demo must be served from the monorepo root because it uses import maps to resolve the elizaOS packages.

```bash
# From the monorepo root
bun run --cwd packages/examples/html start
```

Then open: **http://localhost:3000/examples/html/**

## How It Works

### Import Maps

The demo uses native ES module import maps to resolve the elizaOS packages to their browser builds:

```html
<script type="importmap">
  {
    "imports": {
      "@elizaos/core": "../../packages/core/dist/browser/index.browser.js",
      "@elizaos/plugin-anthropic": "../../plugins/plugin-anthropic/dist/browser/index.browser.js",
      "@elizaos/plugin-elizacloud": "../../plugins/plugin-elizacloud/dist/browser/index.browser.js",
      "@elizaos/plugin-openai": "../../plugins/plugin-openai/dist/browser/index.browser.js",
      "@elizaos/plugin-openrouter": "../../plugins/plugin-openrouter/dist/browser/index.browser.js",
      "@elizaos/plugin-localdb": "../../plugins/plugin-localdb/dist/browser/index.browser.js",
      "uuid": "https://esm.sh/uuid@11"
    }
  }
</script>
```

### Runtime Initialization (mirrors chat.ts)

```javascript
import {
  AgentRuntime,
  ChannelType,
  stringToUuid,
  ModelType,
} from "@elizaos/core";
import { plugin as localdbPlugin } from "@elizaos/plugin-localdb";
import { v4 as uuidv4 } from "uuid";

// Load the provider chosen by which API key is configured (openai by priority).
const providerPlugin = (await import("@elizaos/plugin-openai")).openaiPlugin;

// Create runtime with plugins (browser version)
const runtime = new AgentRuntime({
  character,
  plugins: [localdbPlugin, providerPlugin],
});
await runtime.initialize();

// Setup connection
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

### Message Handling (full pipeline)

```javascript
const message = createMessageMemory({
  id: uuidv4(),
  entityId: userId,
  roomId,
  content: { text, source: "client_chat", channelType: ChannelType.DM },
});

await runtime.messageService.handleMessage(runtime, message, callback);
```

## Comparison: Browser vs Node.js

| Feature  | chat.ts (Node.js)   | index.html (Browser)             |
| -------- | ------------------- | -------------------------------- |
| Runtime  | AgentRuntime        | AgentRuntime                     |
| Database | plugin-sql (PGLite) | plugin-localdb (localStorage)    |
| Model    | plugin-openai       | key-selected provider plugin     |
| UI       | readline (CLI)      | HTML/CSS Terminal                |
| API Keys | Required (OpenAI)   | Required (one provider key)      |

## Project Structure

```
examples/html/
├── index.html      # Complete demo with elizaOS runtime
├── package.json    # Serve scripts
└── README.md       # This file
```

## Prerequisites

Make sure the elizaOS packages are built:

```bash
# From monorepo root
bun install
bun run build
```

## Validate

```bash
bun run test
```

The local test checks the import map, required chat controls, and browser
runtime wiring without starting a server.

## License

MIT
