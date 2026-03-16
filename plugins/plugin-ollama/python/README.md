# elizaOS Plugin Ollama (Python)

Ollama plugin for elizaOS - Local LLM client for text and object generation.

## Installation

```bash
pip install elizaos-plugin-ollama
```

## Usage

```python
from elizaos_plugin_ollama import OllamaClient, OllamaConfig

# Create a client with default configuration
config = OllamaConfig.from_env()
client = OllamaClient(config)

# Generate text
response = await client.generate_text_large("What is the meaning of life?")
print(response.text)

# Generate embeddings
embedding = await client.generate_embedding("Hello, world!")
print(f"Embedding dimension: {len(embedding.embedding)}")
```

## Configuration

The client can be configured via environment variables:

| Variable                 | Description                     | Default                   |
| ------------------------ | ------------------------------- | ------------------------- |
| `OLLAMA_API_ENDPOINT`    | Base URL for the Ollama API     | `http://localhost:11434`  |
| `OLLAMA_SMALL_MODEL`     | Model for small text generation | `gemma3:latest`           |
| `OLLAMA_LARGE_MODEL`     | Model for large text generation | `gemma3:latest`           |
| `OLLAMA_EMBEDDING_MODEL` | Model for embeddings            | `nomic-embed-text:latest` |
| `OLLAMA_TIMEOUT_SECONDS` | Request timeout                 | `300`                     |

## Features

- **Text Generation**: Generate text using small or large models
- **Object Generation**: Generate structured JSON objects
- **Text Embeddings**: Generate embeddings for semantic search
- **Model Management**: Automatic model downloading if not available locally

## Requirements

- Python 3.11+
- Running Ollama server (https://ollama.ai)

## License

MIT



