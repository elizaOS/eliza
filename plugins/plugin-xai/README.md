# @elizaos/plugin-xai

xAI integration for elizaOS: Grok models and X (Twitter) API.

## Installation

```bash
pnpm add @elizaos/plugin-xai
```

## Configuration

### xAI Grok

```env
XAI_API_KEY=your-api-key
XAI_MODEL=grok-3         # optional, default: grok-3
XAI_SMALL_MODEL=grok-3-mini  # optional
```

### X (Twitter)

```env
# OAuth 1.0a (recommended)
X_AUTH_MODE=env
X_API_KEY=your-api-key
X_API_SECRET=your-api-secret
X_ACCESS_TOKEN=your-access-token
X_ACCESS_TOKEN_SECRET=your-access-token-secret

# Or Bearer token
X_AUTH_MODE=bearer
X_BEARER_TOKEN=your-bearer-token

# Features
X_ENABLE_POST=true       # autonomous posting
X_ENABLE_REPLIES=true    # mention handling
X_ENABLE_ACTIONS=true    # likes, reposts
```

## Usage

```typescript
import { XAIPlugin } from "@elizaos/plugin-xai";

// Register with runtime
const runtime = new AgentRuntime({
  plugins: [XAIPlugin],
});

// Use Grok models
const text = await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt: "Explain quantum computing",
});

// Use X service
const service = runtime.getService("x") as XService;
const profile = await service.xClient.client.xClient.me();
```

## Multi-Language Support

This plugin includes implementations in:
- **TypeScript** (`typescript/`) - Primary implementation
- **Python** (`python/`) - `pip install elizaos-plugin-xai`
- **Rust** (`rust/`) - `cargo add elizaos-plugin-xai`

## Development

```bash
# Build
pnpm build

# Test
pnpm test

# Lint
pnpm lint
```

## License

MIT
