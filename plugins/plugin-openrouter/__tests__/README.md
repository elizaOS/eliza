# OpenRouter Plugin Tests

This directory contains integration tests for the OpenRouter plugin.

## Environment Setup

Create a `.env` file in the root directory with the following variables:

```
# Required
OPENROUTER_API_KEY=your_api_key_here

# Optional - defaults will be used if not specified
# OPENROUTER_SMALL_MODEL=google/gemini-flash
# OPENROUTER_LARGE_MODEL=google/gemini-pro
# OPENROUTER_IMAGE_MODEL=x-ai/grok-2-vision-1212
# OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-small
# OPENROUTER_EMBEDDING_DIMENSIONS=1536
# OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

## Running Tests

```bash
# Run all tests
bun run test

# Run tests in watch mode
bun run test:watch
```

## Model Configuration

The OpenRouter plugin supports the following model types:

- `TEXT_SMALL`: For shorter text completions (default: google/gemini-flash)
- `TEXT_LARGE`: For longer text completions (default: google/gemini-pro)
- `OBJECT_SMALL`: For generating structured JSON objects with the small model
- `OBJECT_LARGE`: For generating structured JSON objects with the large model
- `IMAGE_DESCRIPTION`: For analyzing and describing images (default: x-ai/grok-2-vision-1212)
- `TEXT_EMBEDDING`: For generating text embeddings (default: openai/text-embedding-3-small) **[NEW]**

You can configure which model to use for each type by setting the appropriate environment variable.

### Embedding Configuration

The TEXT_EMBEDDING support allows you to use OpenRouter for generating embeddings. The plugin supports configurable embedding dimensions (512, 768, 1024, 1536, or 3072). The default is 1536, which matches the OpenAI text-embedding-3-small model. If you use a different embedding model with OpenRouter, ensure you set the correct dimension via `OPENROUTER_EMBEDDING_DIMENSIONS`.
