# AI Gateway Plugin for elizaOS

Access 100+ AI models through Vercel AI Gateway and other unified gateways with automatic failover, caching, and centralized billing. Optimized for Vercel AI Gateway with full support for OpenRouter and other OpenAI-compatible endpoints.

## Features

- 🚀 **100+ AI Models** - OpenAI, Anthropic, Google, Meta, Mistral, and more
- 🔄 **Universal Gateway Support** - Works with any OpenAI-compatible gateway
- 💾 **Response Caching** - LRU cache for cost optimization
- 📊 **Built-in Telemetry** - Track usage and performance
- 🔐 **Flexible Authentication** - API keys and OIDC support
- ⚡ **High Performance** - Retry logic and connection pooling
- 🎯 **Multiple Actions** - Text, image, embeddings, and model listing

## Installation

### NPM Package (Available Now)
```bash
# Install from npm registry
npm install @promptordie/plugin-aigateway

# Or using bun
bun add @promptordie/plugin-aigateway
```

### Official ElizaOS Registry (Coming Soon)
Once merged into the official ElizaOS ecosystem:
```bash
# Will be available as
npm install @elizaos/plugin-aigateway
```

## Quick Start

### 1. Get Your API Key

For **Vercel AI Gateway**:
1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Navigate to the AI Gateway tab
3. Click "API keys" → "Create key"
4. Copy your new API key

### 2. Set Environment Variables

```env
# Required: Your Vercel AI Gateway API key
AIGATEWAY_API_KEY=your_vercel_api_key_here

# Optional: Customize gateway URL (defaults to Vercel)
AIGATEWAY_BASE_URL=https://ai-gateway.vercel.sh/v1

# Optional: Model configuration (use colon format for Vercel)
AIGATEWAY_DEFAULT_MODEL=openai:gpt-4o-mini
AIGATEWAY_LARGE_MODEL=openai:gpt-4o
AIGATEWAY_EMBEDDING_MODEL=openai:text-embedding-3-small

# Optional: Performance settings
AIGATEWAY_CACHE_TTL=300
AIGATEWAY_MAX_RETRIES=3
```

### 3. Add to Your Character

```json
{
  "name": "MyAgent",
  "plugins": ["@promptordie/plugin-aigateway"],
  "settings": {
    "AIGATEWAY_API_KEY": "your_api_key_here"
  }
}
```

Or if using the official ElizaOS version (once available):
```json
{
  "name": "MyAgent",
  "plugins": ["@elizaos/plugin-aigateway"],
  "settings": {
    "AIGATEWAY_API_KEY": "your_api_key_here"
  }
}
```

### 4. Run Your Agent

```bash
npm run start -- --character path/to/character.json
```

## Supported Gateways

### Vercel AI Gateway (Default) ✅
```env
AIGATEWAY_BASE_URL=https://ai-gateway.vercel.sh/v1
AIGATEWAY_API_KEY=your_vercel_api_key
```

**Key Features with Vercel:**
- 100+ models through a single endpoint
- Automatic fallbacks and retries
- Built-in monitoring and analytics
- App attribution tracking
- Budget controls and spending limits

**Model Format:** Use colon separator (e.g., `openai:gpt-4o`, `anthropic:claude-3-5-sonnet`)

### OpenRouter
```env
AIGATEWAY_BASE_URL=https://openrouter.ai/api/v1
AIGATEWAY_API_KEY=your_openrouter_api_key
```
**Model Format:** Use slash separator (e.g., `openai/gpt-4o`, `anthropic/claude-3-5-sonnet`)

### Custom Gateway
Any OpenAI-compatible endpoint:
```env
AIGATEWAY_BASE_URL=https://your-gateway.com/v1
AIGATEWAY_API_KEY=your_gateway_api_key
```

## Available Models

### OpenAI
- `openai:gpt-4o`, `openai:gpt-4o-mini`
- `openai:gpt-3.5-turbo`
- `openai:dall-e-3` (images)
- `openai:text-embedding-3-small`, `openai:text-embedding-3-large`

### Anthropic
- `anthropic:claude-3-5-sonnet`
- `anthropic:claude-3-opus`
- `anthropic:claude-3-haiku`

### Google
- `google:gemini-2.0-flash`
- `google:gemini-1.5-pro`
- `google:gemini-1.5-flash`

### Meta
- `meta:llama-3.1-405b`
- `meta:llama-3.1-70b`
- `meta:llama-3.1-8b`

### Mistral
- `mistral:mistral-large`
- `mistral:mistral-medium`
- `mistral:mistral-small`


## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AIGATEWAY_API_KEY` | - | Your gateway API key (required) |
| `AIGATEWAY_BASE_URL` | `https://ai-gateway.vercel.sh/v1` | Gateway endpoint URL |
| `AIGATEWAY_DEFAULT_MODEL` | `openai:gpt-4o-mini` | Default small model (Vercel format) |
| `AIGATEWAY_LARGE_MODEL` | `openai:gpt-4o` | Default large model (Vercel format) |
| `AIGATEWAY_EMBEDDING_MODEL` | `openai:text-embedding-3-small` | Embedding model (Vercel format) |
| `AIGATEWAY_CACHE_TTL` | `300` | Cache TTL in seconds |
| `AIGATEWAY_MAX_RETRIES` | `3` | Max retry attempts |
| `AIGATEWAY_USE_OIDC` | `false` | Enable OIDC authentication |

## Actions

The plugin provides the following actions:

### GENERATE_TEXT
Generate text using any available model.

```typescript
{
  action: "GENERATE_TEXT",
  content: {
    text: "Write a haiku about AI",
    temperature: 0.7,
    maxTokens: 100,
    useSmallModel: true  // Optional: use smaller/faster model
  }
}
```

### GENERATE_IMAGE
Generate images using DALL-E or compatible models.

```typescript
{
  action: "GENERATE_IMAGE",
  content: {
    prompt: "A futuristic city at sunset",
    size: "1024x1024",
    n: 1
  }
}
```

### GENERATE_EMBEDDING
Generate text embeddings for semantic search.

```typescript
{
  action: "GENERATE_EMBEDDING",
  content: {
    text: "Text to embed"
  }
}
```

### LIST_MODELS
List available models from the gateway.

```typescript
{
  action: "LIST_MODELS",
  content: {
    type: "text",  // Optional: filter by type
    provider: "openai"  // Optional: filter by provider
  }
}
```

## Usage Examples

### Basic Usage

```typescript
// Using npm package (available now)
import aiGatewayPlugin from '@promptordie/plugin-aigateway';

// Or when using official ElizaOS version (once available)
// import aiGatewayPlugin from '@elizaos/plugin-aigateway';

const character = {
    name: 'MyAgent',
    plugins: [aiGatewayPlugin],
    settings: {
        AIGATEWAY_API_KEY: 'your-vercel-api-key',
        AIGATEWAY_DEFAULT_MODEL: 'openai:gpt-4o-mini'
    }
};
```

### Custom Gateway Configuration

```typescript
const character = {
    name: 'MyAgent',
    plugins: [aiGatewayPlugin],
    settings: {
        AIGATEWAY_API_KEY: 'your-openrouter-key',
        AIGATEWAY_BASE_URL: 'https://openrouter.ai/api/v1',
        AIGATEWAY_DEFAULT_MODEL: 'anthropic/claude-3-haiku',  // Use slash for OpenRouter
        AIGATEWAY_LARGE_MODEL: 'anthropic/claude-3-5-sonnet'
    }
};
```

### Using in Code

```typescript
// The plugin automatically registers model providers
const response = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: 'Explain quantum computing',
    temperature: 0.7,
    maxTokens: 500
});

// Generate embeddings
const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
    text: 'Text to embed'
});

// Generate images
const images = await runtime.useModel(ModelType.IMAGE, {
    prompt: 'A beautiful landscape',
    size: '1024x1024'
});
```

## Testing

```bash
# Run plugin tests
npm test

# Test with elizaOS CLI (using npm package)
elizaos test --plugin @promptordie/plugin-aigateway

# Or with official package (once available)
# elizaos test --plugin @elizaos/plugin-aigateway
```

## Development

```bash
# Install dependencies
npm install

# Build the plugin
npm run build

# Watch mode for development
npm run dev

# Format code
npm run format
```

## Architecture

The plugin follows the standard elizaOS plugin architecture:

- **Actions**: User-facing commands for text/image generation
- **Providers**: Core model provider logic with caching
- **Utils**: Configuration and caching utilities
- **Types**: TypeScript type definitions

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT © elizaOS Community

## Support

For issues and questions:
- GitHub Issues: [plugin-aigateway/issues](https://github.com/elizaos-plugins/plugin-aigateway/issues)
- Discord: [elizaOS Community](https://discord.gg/elizaos)