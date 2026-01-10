![AI Gateway Plugin](./images/banner.jpg)

## plugin-ai-gateway

Lightweight AI Gateway provider plugin for ElizaOS. It connects your agent to an OpenAI-compatible AI Gateway (e.g., Cloudflare AI Gateway) for text, objects, embeddings, images, TTS, and transcription.

### Features
- **Text generation**: `TEXT_SMALL`, `TEXT_LARGE` chat completions
- **Structured objects**: `OBJECT_SMALL`, `OBJECT_LARGE` with JSON-only responses
- **Embeddings**: vector embeddings generation
- **Images**: image generation
- **Speech**: transcription and text-to-speech (TTS)

### Install
```bash
bun install
```

### Environment Variable Configuration
Set via ElizaOS runtime settings or environment variables:

- AI_GATEWAY_API_KEY (required)
- AI_GATEWAY_BASE_URL (default: https://gateway.ai.cloudflare.com/v1)
- AI_GATEWAY_OPENAI_COMPATIBLE_URL (optional)
- AI_GATEWAY_ACCOUNT_ID (optional)
- AI_GATEWAY_WORKSPACE (optional)
- AI_GATEWAY_SMALL_MODEL (default: @cf/meta/llama-3.1-8b-instruct)
- AI_GATEWAY_LARGE_MODEL (default: @cf/meta/llama-3.1-70b-instruct)
- AI_GATEWAY_EMBEDDING_MODEL (default: @cf/baai/bge-base-en-v1.5)
- AI_GATEWAY_IMAGE_MODEL (default: @cf/stabilityai/stable-diffusion-xl-base-1.0)

Optional per-model tuning (read by handlers):
- DEFAULT_MAX_TOKENS
- OBJECT_SMALL_MAX_TOKENS
- OBJECT_LARGE_MAX_TOKENS
- DEFAULT_TEMPERATURE

Example `.env` snippet:
```env
AI_GATEWAY_API_KEY=your_key_here
AI_GATEWAY_BASE_URL=https://gateway.ai.cloudflare.com/v1
AI_GATEWAY_SMALL_MODEL=@cf/meta/llama-3.1-8b-instruct
AI_GATEWAY_LARGE_MODEL=@cf/meta/llama-3.1-70b-instruct
DEFAULT_MAX_TOKENS=8192
```

### Usage
Import and register the plugin with your agent.

```ts
import aiGatewayPlugin from "@elizaos/plugin-gateway";
import { createAgent } from "@elizaos/core";

const agent = createAgent({
  plugins: [aiGatewayPlugin],
});
```

Handlers conform to `@elizaos/core` model types and are selected via `runtime.useModel(...)`.

Key handlers:
- `TEXT_SMALL`, `TEXT_LARGE` → chat completions
- `OBJECT_SMALL`, `OBJECT_LARGE` → JSON objects (response_format: json_object)
- `TEXT_EMBEDDING` → embeddings
- `IMAGE` → image generation
- `TRANSCRIPTION` → speech-to-text
- `TEXT_TO_SPEECH` → TTS

### Configuration Notes
- Object generation uses `OBJECT_SMALL_MAX_TOKENS` / `OBJECT_LARGE_MAX_TOKENS` with fallback to `DEFAULT_MAX_TOKENS` and finally 8192.
- Text generation respects `temperature`, `stopSequences`, and penalties if provided.

### Development
```bash
bun run lint
bun run build
bun test
```

### License
MIT

ElizaOS AI Gateway Plugin
A comprehensive AI Gateway plugin for ElizaOS that provides access to multiple AI models through both standard AI Gateway endpoints and OpenAI-compatible interfaces. This plugin supports all ElizaOS model types including text generation, embeddings, image generation, transcription, and more.

Features
🎯 Complete Model Coverage: Supports all ElizaOS model types

TEXT_SMALL & TEXT_LARGE for text generation

TEXT_EMBEDDING for vector embeddings

OBJECT_SMALL & OBJECT_LARGE for structured output

IMAGE for image generation

IMAGE_DESCRIPTION for vision capabilities

TRANSCRIPTION for speech-to-text

TEXT_TO_SPEECH for text-to-speech

TEXT_TOKENIZER_ENCODE & TEXT_TOKENIZER_DECODE

🚀 Dual Endpoint Support:

Native AI Gateway endpoints

OpenAI-compatible endpoints for seamless integration

🔧 Flexible Configuration: Support for multiple providers through AI Gateway

Cloudflare Workers AI models

OpenAI models through gateway

Anthropic, Google, and other provider models

🛡️ Production Ready:

Comprehensive error handling

Usage tracking and telemetry

Connection testing and validation

Type-safe TypeScript implementation

Installation
Method 1: Using ElizaOS CLI (Recommended)
bash
elizaos plugins add @elizaos/plugin-gateway
Method 2: Manual Installation
bash
npm install @elizaos/plugin-gateway
or

bash
pnpm add @elizaos/plugin-gateway
Configuration
Environment Variables
Create a .env file in your project root or set these environment variables:

bash
# Required
AI_GATEWAY_API_KEY=your_ai_gateway_api_key_here

# Optional - Base URLs
AI_GATEWAY_BASE_URL=https://gateway.ai.cloudflare.com/v1
AI_GATEWAY_OPENAI_COMPATIBLE_URL=https://gateway.ai.cloudflare.com/v1/your_account/your_gateway/openai

# Optional - Account Details
AI_GATEWAY_ACCOUNT_ID=your_cloudflare_account_id
AI_GATEWAY_WORKSPACE=your_gateway_workspace_name

# Model Configuration
AI_GATEWAY_SMALL_MODEL=@cf/meta/llama-3.1-8b-instruct
AI_GATEWAY_LARGE_MODEL=@cf/meta/llama-3.1-70b-instruct
AI_GATEWAY_EMBEDDING_MODEL=@cf/baai/bge-base-en-v1.5
AI_GATEWAY_IMAGE_MODEL=@cf/stabilityai/stable-diffusion-xl-base-1.0
Character Configuration
Add the plugin to your character configuration:

json
{
  "name": "MyAgent",
  "plugins": ["@elizaos/plugin-gateway"],
  "settings": {
    "secrets": {
      "AI_GATEWAY_API_KEY": "your_api_key_here"
    }
  }
}
Usage
Basic Text Generation
typescript
import { ModelType } from '@elizaos/core';

// Small model for quick responses
const quickResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt: "Hello, how are you?"
});

// Large model for complex tasks
const detailedResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Explain quantum computing in detail",
  temperature: 0.7,
  maxTokens: 2000
});
Embeddings
typescript
// Generate embeddings
const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
  text: "This text will be converted to vectors"
});

console.log(embedding); // Array of numbers
Structured Object Generation
typescript
// Generate structured JSON objects
const userProfile = await runtime.useModel(ModelType.OBJECT_SMALL, {
  prompt: "Create a user profile",
  schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
      interests: { type: "array", items: { type: "string" } }
    }
  }
});
Image Generation
typescript
// Generate images
const images = await runtime.useModel(ModelType.IMAGE, {
  prompt: "A beautiful sunset over mountains",
  n: 1,
  size: "1024x1024"
});

console.log(images.url); // Generated image URL
Image Description
typescript
// Describe images
const description = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
  imageUrl: "https://example.com/image.jpg",
  prompt: "What do you see in this image?"
});
Audio Transcription
typescript
// Transcribe audio
const transcription = await runtime.useModel(ModelType.TRANSCRIPTION, audioBuffer);
console.log(transcription); // Transcribed text
Supported Model Providers
The plugin works with any model provider supported by your AI Gateway configuration:

Cloudflare Workers AI
bash
AI_GATEWAY_SMALL_MODEL=@cf/meta/llama-3.1-8b-instruct
AI_GATEWAY_LARGE_MODEL=@cf/meta/llama-3.1-70b-instruct
AI_GATEWAY_EMBEDDING_MODEL=@cf/baai/bge-base-en-v1.5
AI_GATEWAY_IMAGE_MODEL=@cf/stabilityai/stable-diffusion-xl-base-1.0
OpenAI through Gateway
bash
AI_GATEWAY_SMALL_MODEL=openai/gpt-4o-mini
AI_GATEWAY_LARGE_MODEL=openai/gpt-4o
AI_GATEWAY_EMBEDDING_MODEL=openai/text-embedding-3-small
AI_GATEWAY_IMAGE_MODEL=openai/dall-e-3
Anthropic through Gateway
bash
AI_GATEWAY_SMALL_MODEL=anthropic/claude-3-haiku-20240307
AI_GATEWAY_LARGE_MODEL=anthropic/claude-3-opus-20240229
Advanced Configuration
Custom Headers and Options
The plugin automatically handles authentication and routing through your AI Gateway configuration. For advanced use cases, you can extend the configuration:

typescript
// Custom model selection per request
const response = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Your prompt here",
  temperature: 0.3,
  maxTokens: 1000,
  // The plugin will use AI_GATEWAY_LARGE_MODEL
});
Error Handling
The plugin includes comprehensive error handling:

typescript
try {
  const result = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: "Your prompt"
  });
} catch (error) {
  console.error("AI Gateway error:", error.message);
  // Plugin provides detailed error information
}
Testing
Run the built-in tests to verify your configuration:

bash
elizaos test ai-gateway
The plugin includes tests for:

Connection validation

Text generation (small and large models)

Embedding generation

Object generation

Error handling

Development
Building from Source
bash
git clone <repository-url>
cd plugin-ai-gateway
npm install
npm run build
Running Tests
bash
npm test
Development Mode
bash
npm run dev
Architecture
Plugin Structure
text
src/
├── index.ts              # Main plugin export
├── types.ts              # TypeScript type definitions
├── handlers/             # Model handlers
│   ├── text.ts          # Text generation handlers
│   ├── embedding.ts     # Embedding handler
│   ├── object.ts        # Object generation handlers
│   ├── image.ts         # Image generation and description
│   ├── transcription.ts # Audio transcription
│   └── tts.ts           # Text-to-speech
└── utils/               # Utilities
    ├── client.ts        # AI Gateway client
    └── config.ts        # Configuration management
Model Handler Registry
The plugin registers handlers for all ElizaOS model types:

TEXT_SMALL → handleTextSmall

TEXT_LARGE → handleTextLarge

TEXT_EMBEDDING → handleTextEmbedding

OBJECT_SMALL → handleObjectSmall

OBJECT_LARGE → handleObjectLarge

IMAGE → handleImageGeneration

IMAGE_DESCRIPTION → handleImageDescription

TRANSCRIPTION → handleTranscription

TEXT_TO_SPEECH → handleTextToSpeech

TEXT_TOKENIZER_ENCODE → tokenizeText

TEXT_TOKENIZER_DECODE → detokenizeText

Troubleshooting
Common Issues
API Key Not Working

text
Error: AI_GATEWAY_API_KEY is required
Ensure your API key is correctly set in environment variables

Check that the key has proper permissions

Model Not Found

text
Error: Model not available through gateway
Verify the model identifier is correct for your gateway configuration

Check that the model is available in your AI Gateway workspace

Connection Failed

text
Error: Failed to connect to AI Gateway
Verify your base URL configuration

Check network connectivity

Ensure your account ID and workspace are correct

Debug Mode
Enable debug logging:

bash
LOG_LEVEL=debug elizaos start
Support
For issues specific to this plugin, please check:

ElizaOS documentation

AI Gateway provider documentation

Plugin test results: elizaos test ai-gateway

Contributing
Fork the repository

Create your feature branch: git checkout -b feature/amazing-feature

Commit your changes: git commit -m 'Add amazing feature'

Push to the branch: git push origin feature/amazing-feature

Open a Pull Request

License
This plugin is part of the ElizaOS ecosystem. See the main project repository for license information.

Changelog
v1.0.0
Initial release

Full ElizaOS model type support

Dual endpoint support (native + OpenAI compatible)

Comprehensive error handling and testing

Production-ready configuration management# plugin-vercel-ai-gateway
# plugin-vercel-ai-gateway
