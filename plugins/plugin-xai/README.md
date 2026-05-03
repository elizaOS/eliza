# @elizaos/plugin-xai (TypeScript)

TypeScript package for elizaOS xAI integration.

## Installation

```bash
pnpm add @elizaos/plugin-xai
```

## Usage

```typescript
import { XAIPlugin } from "@elizaos/plugin-xai";
import { AgentRuntime, ModelType } from "@elizaos/core";

// Register plugin
const runtime = new AgentRuntime({
  plugins: [XAIPlugin],
});

// Use Grok models
const text = await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt: "Explain quantum computing",
});

// Use X service
const xService = runtime.getService("x") as XService;
const profile = await xService.xClient.client.xClient.me();
console.log(`@${profile.username}`);
```

## Development

```bash
# Build
bun run build

# Test
npx vitest

# Lint
bun run lint

# Type check
bun run typecheck
```
