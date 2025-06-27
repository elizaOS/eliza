# ElizaOS Plugin Ordering System

This directory contains comprehensive tests and documentation for ElizaOS's plugin ordering system, which ensures that embedding-capable plugins are always loaded last to serve as fallbacks.

## Overview

ElizaOS uses a sophisticated plugin loading system that automatically detects available API keys and services, then loads plugins in a specific order to ensure proper fallback behavior for embeddings.

### Key Principles

1. **Embedding Plugins Last**: Plugins that support embeddings (OpenAI, Ollama, Google GenAI, Local-AI) are always loaded with the lowest priority
2. **Local-AI as Final Fallback**: When no other AI providers are available, Local-AI serves as the ultimate fallback
3. **Text-Only Plugins First**: Providers without embedding support (Anthropic, OpenRouter) load before embedding-capable plugins
4. **Environment-Driven**: Plugin selection is automatic based on available environment variables

## Plugin Categories

### 🗄️ Core Plugins
- `@elizaos/plugin-sql` - Always loaded first, provides database functionality

### 📝 Text-Only AI Plugins (No Embedding Support)
- `@elizaos/plugin-anthropic` - Claude models (text generation only)
- `@elizaos/plugin-openrouter` - Multiple AI models (no embeddings endpoint)

### 🌐 Platform Plugins
- `@elizaos/plugin-discord` - Discord integration
- `@elizaos/plugin-twitter` - Twitter integration (requires 4 API tokens)
- `@elizaos/plugin-telegram` - Telegram bot integration

### 🚀 Bootstrap Plugin
- `@elizaos/plugin-bootstrap` - Default event handlers, actions, and providers

### 🧠 Embedding-Capable AI Plugins (Always Last)
- `@elizaos/plugin-openai` - GPT models + embeddings
- `@elizaos/plugin-ollama` - Local models + embeddings
- `@elizaos/plugin-google-genai` - Gemini models + embeddings
- `@elizaos/plugin-local-ai` - Final fallback when no other AI providers exist

## Plugin Loading Order

The system loads plugins in this strict order:

```
1. Core Plugins (SQL)
2. Text-Only AI Plugins (Anthropic, OpenRouter)
3. Platform Plugins (Discord, Twitter, Telegram)
4. Bootstrap Plugin
5. Embedding-Capable AI Plugins (OpenAI, Ollama, Google, Local-AI)
```

## Environment Detection Logic

### AI Provider Detection
```typescript
// Text-only providers (loaded first)
...(process.env.ANTHROPIC_API_KEY ? ['@elizaos/plugin-anthropic'] : []),
...(process.env.OPENROUTER_API_KEY ? ['@elizaos/plugin-openrouter'] : []),

// Embedding providers (loaded last)
...(process.env.OPENAI_API_KEY ? ['@elizaos/plugin-openai'] : []),
...(process.env.OLLAMA_API_ENDPOINT ? ['@elizaos/plugin-ollama'] : []),
...(process.env.GOOGLE_GENERATIVE_AI_API_KEY ? ['@elizaos/plugin-google-genai'] : []),

// Final fallback (only when no other AI providers exist)
...(!process.env.ANTHROPIC_API_KEY &&
    !process.env.OPENROUTER_API_KEY &&
    !process.env.GOOGLE_GENERATIVE_AI_API_KEY &&
    !process.env.OLLAMA_API_ENDPOINT &&
    !process.env.OPENAI_API_KEY
      ? ['@elizaos/plugin-local-ai']
      : []),
```

### Platform Plugin Detection
```typescript
...(process.env.DISCORD_API_TOKEN ? ['@elizaos/plugin-discord'] : []),
...(process.env.TELEGRAM_BOT_TOKEN ? ['@elizaos/plugin-telegram'] : []),

// Twitter requires ALL 4 tokens
...(process.env.TWITTER_API_KEY &&
    process.env.TWITTER_API_SECRET_KEY &&
    process.env.TWITTER_ACCESS_TOKEN &&
    process.env.TWITTER_ACCESS_TOKEN_SECRET
      ? ['@elizaos/plugin-twitter']
      : []),
```

## Test Files

### `character-plugin-ordering.test.ts`
Comprehensive test suite covering:
- Core plugin ordering
- Local-AI fallback behavior
- Embedding plugin priority
- Complex environment combinations
- Edge cases and validation

### `plugin-ordering-demo.ts`
Interactive demonstration script showing:
- 9 different environment scenarios
- Visual plugin ordering output
- Automatic validation of ordering rules
- Real-time environment variable testing

## Running Tests

### Run Plugin Ordering Tests
```bash
# CLI package tests
cd packages/cli
bun test src/__tests__/character-plugin-ordering.test.ts

# Project starter tests
cd packages/project-starter
bun test src/__tests__/character-plugin-ordering.test.ts
```

### Run Interactive Demo
```bash
cd packages/cli
bun run src/__tests__/plugin-ordering-demo.ts
```

## Test Scenarios Covered

### 1. No AI Providers
- **Environment**: Clean (no API keys)
- **Result**: SQL → Bootstrap → Local-AI
- **Validation**: Local-AI serves as fallback

### 2. Anthropic Only
- **Environment**: `ANTHROPIC_API_KEY`
- **Result**: SQL → Anthropic → Bootstrap
- **Validation**: No embedding plugin needed (Anthropic handles text only)

### 3. OpenAI Only
- **Environment**: `OPENAI_API_KEY`
- **Result**: SQL → Bootstrap → OpenAI
- **Validation**: OpenAI handles both text and embeddings

### 4. Mixed Providers
- **Environment**: `ANTHROPIC_API_KEY` + `OPENAI_API_KEY`
- **Result**: SQL → Anthropic → Bootstrap → OpenAI
- **Validation**: Text-only first, embedding-capable last

### 5. All Providers
- **Environment**: All AI provider keys
- **Result**: SQL → Anthropic → OpenRouter → Bootstrap → OpenAI → Ollama → Google
- **Validation**: No Local-AI fallback needed

### 6. Platform Integration
- **Environment**: AI providers + Discord/Twitter/Telegram
- **Result**: Core → AI Text → Platforms → Bootstrap → AI Embedding
- **Validation**: Platform plugins properly positioned

### 7. Bootstrap Disabled
- **Environment**: `IGNORE_BOOTSTRAP=true`
- **Result**: Only core and AI plugins loaded
- **Validation**: Bootstrap correctly excluded

## Validation Rules

The test suite validates these critical rules:

1. ✅ **SQL Always First**: `@elizaos/plugin-sql` must be the first plugin
2. ✅ **Embedding Plugins Last**: OpenAI, Ollama, Google, Local-AI load after text-only plugins
3. ✅ **Local-AI Fallback**: Only present when no other AI providers exist
4. ✅ **Bootstrap Positioning**: Loads before embedding plugins (unless disabled)
5. ✅ **Platform Integration**: Platform plugins positioned between AI categories
6. ✅ **No Duplicates**: Each plugin appears exactly once
7. ✅ **Consistent Ordering**: Same environment produces same plugin order

## Why This Matters

### Embedding Fallback Strategy
When a primary AI provider (like Anthropic/Claude) doesn't support embeddings:
1. The text-only plugin handles chat/generation
2. An embedding-capable plugin provides embeddings
3. Plugin order ensures the right plugin handles each request type

### Example: Anthropic + OpenAI Setup
```typescript
plugins: [
  '@elizaos/plugin-sql',        // Database
  '@elizaos/plugin-anthropic',  // Primary AI (text only)
  '@elizaos/plugin-bootstrap',  // Default handlers
  '@elizaos/plugin-openai'      // Embedding fallback
]
```

When ElizaOS needs:
- **Text generation**: Anthropic handles it (higher priority)
- **Embeddings**: OpenAI handles it (only embedding provider)

### Example: OpenAI Only Setup
```typescript
plugins: [
  '@elizaos/plugin-sql',        // Database
  '@elizaos/plugin-bootstrap',  // Default handlers
  '@elizaos/plugin-openai'      // Handles both text and embeddings
]
```

OpenAI handles both text generation and embeddings since it's the only AI provider.

## Files Using This System

This plugin ordering logic is implemented consistently across:

- `packages/cli/src/characters/eliza.ts` - CLI character
- `packages/project-starter/src/character.ts` - Project template
- `packages/project-tee-starter/src/character.ts` - TEE project template
- `AGENTS.md` - Documentation examples

All use identical logic to ensure consistent behavior across the ElizaOS ecosystem.

## Contributing

When adding new plugins:

1. **Determine Category**: Is it core, AI (text/embedding), platform, or utility?
2. **Place Correctly**: Add to appropriate section in plugin array
3. **Add Tests**: Include test cases in the plugin ordering test suite
4. **Update Demo**: Add scenario to `plugin-ordering-demo.ts` if relevant
5. **Document**: Update this README with new plugin information

## Troubleshooting

### Common Issues

**Q: Why isn't my AI plugin loading?**
A: Check environment variables are set correctly and match the expected names.

**Q: Why is Local-AI loading when I have other AI providers?**
A: Check the fallback condition - Local-AI only loads when ALL other AI provider env vars are missing.

**Q: Why isn't Twitter loading?**
A: Twitter requires ALL 4 environment variables: API key, secret, access token, and access token secret.

**Q: Plugin order seems wrong?**
A: Run the demo script to see actual ordering and validation results:
```bash
bun run src/__tests__/plugin-ordering-demo.ts
```

### Debugging Plugin Loading

Use the demo script to diagnose plugin loading issues:

1. Set your environment variables
2. Run the demo to see actual vs expected plugin order
3. Check validation results for specific issues
4. Verify environment variable names match expected patterns

The demo provides detailed output showing which plugins loaded and why, making it easy to troubleshoot configuration issues.