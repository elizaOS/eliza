# Ollama Plugin

This plugin provides integration with [Ollama](https://ollama.com/)'s local models through the ElizaOS platform. It allows you to leverage locally running LLMs for text generation, embeddings, and object generation.

## Overview

Ollama enables running large language models locally on your machine. This plugin connects ElizaOS with your local Ollama installation, giving your characters access to powerful language models running on your own hardware.

## Requirements

- [Ollama](https://ollama.com/) installed and running on your system
- ElizaOS platform
- At least one Ollama model pulled and available (e.g., `llama3`, `gemma3:latest`)

## Installation

1. Install this plugin in your ElizaOS project:

   ```bash
   bun add @elizaos/plugin-ollama
   ```

2. Make sure Ollama is running:
   ```bash
   ollama serve
   ```

## Usage

Add the plugin to your character configuration:

```json
"plugins": ["@elizaos/plugin-ollama"]
```

## Configuration

The plugin requires these environment variables (can be set in .env file or character settings):

```json
"settings": {
  "OLLAMA_API_ENDPOINT": "http://localhost:11434/api",
  "OLLAMA_SMALL_MODEL": "gemma3:latest",
  "OLLAMA_MEDIUM_MODEL": "gemma3:latest",
  "OLLAMA_LARGE_MODEL": "gemma3:latest",
  "OLLAMA_EMBEDDING_MODEL": "nomic-embed-text:latest"
}
```

Or in `.env` file:

```
OLLAMA_API_ENDPOINT=http://localhost:11434/api
OLLAMA_SMALL_MODEL=gemma3:latest
OLLAMA_MEDIUM_MODEL=gemma3:latest
OLLAMA_LARGE_MODEL=gemma3:latest
OLLAMA_EMBEDDING_MODEL=nomic-embed-text:latest
```

### Configuration Options

- `OLLAMA_API_ENDPOINT`: Ollama API endpoint (default: http://localhost:11434/api)
- `OLLAMA_SMALL_MODEL`: Model for simpler tasks (default: gemma3:latest)
- `OLLAMA_MEDIUM_MODEL`: Medium-complexity model (default: gemma3:latest)
- `OLLAMA_LARGE_MODEL`: Model for complex tasks (default: gemma3:latest)
- `OLLAMA_EMBEDDING_MODEL`: Model for text embeddings (default: nomic-embed-text:latest)

The plugin provides these model classes:

- `TEXT_SMALL`: Optimized for fast responses with simpler prompts
- `TEXT_LARGE`: For complex tasks requiring deeper reasoning
- `TEXT_EMBEDDING`: Text embedding model
- `OBJECT_SMALL`: JSON object generation with simpler models
- `OBJECT_LARGE`: JSON object generation with more complex models

## API Reference

For detailed information about the Ollama API used by this plugin, refer to the [official Ollama API documentation](https://github.com/ollama/ollama/blob/main/docs/api.md).

## Features

### Text Generation (Small Model)

Generate text using smaller, faster models optimized for quick responses:

```js
const text = await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt: "What is the nature of reality?",
  stopSequences: [], // optional
});
```

### Text Generation (Large Model)

Generate comprehensive text responses using more powerful models for complex tasks:

```js
const text = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Write a detailed explanation of quantum physics",
  stopSequences: [], // optional
  maxTokens: 8192, // optional (default: 8192)
  temperature: 0.7, // optional (default: 0.7)
  frequencyPenalty: 0.7, // optional (default: 0.7)
  presencePenalty: 0.7, // optional (default: 0.7)
});
```

### Text Embeddings

Generate vector embeddings for text, which can be used for semantic search or other vector operations:

```js
const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
  text: "Text to embed",
});
// or
const embedding = await runtime.useModel(
  ModelType.TEXT_EMBEDDING,
  "Text to embed",
);
```

### Object Generation (Small Model)

Generate structured JSON objects using faster models:

```js
const object = await runtime.useModel(ModelType.OBJECT_SMALL, {
  prompt: "Generate a JSON object representing a user profile",
  temperature: 0.7, // optional
});
```

### Object Generation (Large Model)

Generate complex, detailed JSON objects using more powerful models:

```js
const object = await runtime.useModel(ModelType.OBJECT_LARGE, {
  prompt: "Generate a detailed JSON object representing a restaurant",
  temperature: 0.7, // optional
});
```

## Troubleshooting

### Connection Issues

- Ensure Ollama is running by testing the `OLLAMA_API_ENDPOINT`
- Verify the `OLLAMA_API_ENDPOINT` points to the correct host and port
- Check firewall settings if connecting to a remote Ollama instance

### Model Availability

- The plugin will attempt to download models automatically if they're not found
- You can pre-download models using `ollama pull modelname`
- Check model availability with `ollama list`

## License

See LICENSE file for details.
