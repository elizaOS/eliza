# Google GenAI Plugin Tests

This directory contains integration tests for the Google GenAI plugin.

## Environment Setup

Create a `.env` file in the root directory with the following variables:

```
# Required
GOOGLE_GENERATIVE_AI_API_KEY=your_api_key_here

# Optional - defaults will be used if not specified
# GOOGLE_SMALL_MODEL=gemini-2.0-flash-001
# GOOGLE_LARGE_MODEL=gemini-2.0-flash-001
# GOOGLE_IMAGE_MODEL=gemini-2.0-flash-001
# GOOGLE_EMBEDDING_MODEL=text-embedding-004
```

## Running Tests

```bash
# Run all tests
bun run test

# Run tests in watch mode
bun run test:watch
```

## Model Configuration

The Google GenAI plugin supports the following model types:

- `TEXT_SMALL`: For shorter text completions (default: gemini-2.0-flash-001)
- `TEXT_LARGE`: For longer text completions (default: gemini-2.0-flash-001)
- `TEXT_EMBEDDING`: For generating text embeddings (default: text-embedding-004)
- `OBJECT_SMALL`: For generating structured JSON objects with the small model
- `OBJECT_LARGE`: For generating structured JSON objects with the large model
- `IMAGE_DESCRIPTION`: For analyzing and describing images (default: gemini-2.0-flash-001)

You can configure which model to use for each type by setting the appropriate environment variable.
