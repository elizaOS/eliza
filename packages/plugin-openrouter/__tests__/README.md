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

You can configure which model to use for each type by setting the appropriate environment variable.
