# ELIZA - elizaOS Browser Demo

A browser-based demo of the **full elizaOS AgentRuntime** using:

- **@elizaos/core** - AgentRuntime, ModelType
- **@elizaos/plugin-localdb** - localStorage persistence (no SQL needed)
- **@elizaos/plugin-eliza-classic** - Classic ELIZA pattern matching (no API keys needed)

This demo mirrors the structure of `examples/chat/typescript/chat.ts` exactly, but runs in the browser.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser Environment                     │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐    │
│  │                   AgentRuntime                       │    │
│  │  ┌──────────────────┐  ┌──────────────────────┐     │    │
│  │  │ plugin-eliza-    │  │  plugin-localdb      │     │    │
│  │  │ classic          │  │  (localStorage)      │     │    │
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
cd /path/to/eliza

# Option 1: Using Python (built into most systems)
python3 -m http.server 3000

# Option 2: Using Node.js serve
npx serve .

# Option 3: Using PHP
php -S localhost:3000
```

Then open: **http://localhost:3000/examples/html/**

## How It Works

### Import Maps

The demo uses native ES module import maps to resolve the elizaOS packages to their browser builds:

```html
<script type="importmap">
  {
    "imports": {
      "@elizaos/core": "../../packages/typescript/dist/browser/index.browser.js",
      "@elizaos/plugin-eliza-classic": "../../plugins/plugin-eliza-classic/typescript/dist/browser/index.browser.js",
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
import { elizaClassicPlugin } from "@elizaos/plugin-eliza-classic";
import { plugin as localdbPlugin } from "@elizaos/plugin-localdb";
import { v4 as uuidv4 } from "uuid";

// Create runtime with plugins (browser version)
const runtime = new AgentRuntime({
  character,
  plugins: [localdbPlugin, elizaClassicPlugin],
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

| Feature  | chat.ts (Node.js)   | index.html (Browser)          |
| -------- | ------------------- | ----------------------------- |
| Runtime  | AgentRuntime        | AgentRuntime                  |
| Database | plugin-sql (PGLite) | plugin-localdb (localStorage) |
| Model    | plugin-openai       | plugin-eliza-classic          |
| UI       | readline (CLI)      | HTML/CSS Terminal             |
| API Keys | Required (OpenAI)   | Not required                  |

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

## License

MIT
