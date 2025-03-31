# Ollama Plugin

This plugin provides integration with Ollama's local models through the ElizaOS platform.

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
  "OLLAMA_SMALL_MODEL": "llama3",
  "OLLAMA_MEDIUM_MODEL": "your_medium_model",
  "OLLAMA_LARGE_MODEL": "gemma3:latest",
  "OLLAMA_EMBEDDING_MODEL": "nomic-embed-text"
}
```

Or in `.env` file:

```
OLLAMA_API_ENDPOINT=http://localhost:11434/api
OLLAMA_SMALL_MODEL=llama3
OLLAMA_MEDIUM_MODEL=your_medium_model
OLLAMA_LARGE_MODEL=gemma3:latest
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
```

### Configuration Options

- `OLLAMA_API_ENDPOINT`: Ollama API endpoint (default: http://localhost:11434/api)
- `OLLAMA_SMALL_MODEL`: Model for simpler tasks (default: llama3)
- `OLLAMA_MEDIUM_MODEL`: Medium-complexity model
- `OLLAMA_LARGE_MODEL`: Model for complex tasks (default: gemma3:latest)
- `OLLAMA_EMBEDDING_MODEL`: Model for text embeddings (default: nomic-embed-text)

The plugin provides these model classes:

- `TEXT_SMALL`: Optimized for fast responses with simpler prompts
- `TEXT_LARGE`: For complex tasks requiring deeper reasoning
- `TEXT_EMBEDDING`: Text embedding model
- `OBJECT_SMALL`: JSON object generation with simpler models
- `OBJECT_LARGE`: JSON object generation with more complex models

## Additional Features

### Text Generation (Small Model)

```js
const text = await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt: 'What is the nature of reality?',
  stopSequences: [], // optional
});
```

### Text Generation (Large Model)

```js
const text = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: 'Write a detailed explanation of quantum physics',
  stopSequences: [], // optional
  maxTokens: 8192, // optional (default: 8192)
  temperature: 0.7, // optional (default: 0.7)
  frequencyPenalty: 0.7, // optional (default: 0.7)
  presencePenalty: 0.7, // optional (default: 0.7)
});
```

### Text Embeddings

```js
const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
  text: 'Text to embed',
});
// or
const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, 'Text to embed');
```

### Object Generation (Small Model)

```js
const object = await runtime.useModel(ModelType.OBJECT_SMALL, {
  prompt: 'Generate a JSON object representing a user profile',
  temperature: 0.7, // optional
});
```

### Object Generation (Large Model)

```js
const object = await runtime.useModel(ModelType.OBJECT_LARGE, {
  prompt: 'Generate a detailed JSON object representing a restaurant',
  temperature: 0.7, // optional
});
```
