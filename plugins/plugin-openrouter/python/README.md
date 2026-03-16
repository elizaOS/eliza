# elizaOS Plugin OpenRouter (Python)

OpenRouter plugin for elizaOS - Multi-model AI gateway client for text and object generation.

## Installation

```bash
pip install elizaos-plugin-openrouter
```

## Usage

```python
from elizaos_plugin_openrouter import OpenRouterClient, OpenRouterConfig

# Create a client with API key
config = OpenRouterConfig.from_env()
client = OpenRouterClient(config)

# Generate text
response = await client.generate_text_large("What is the meaning of life?")
print(response.text)

# Generate embeddings
embedding = await client.generate_embedding("Hello, world!")
print(f"Embedding dimension: {len(embedding.embedding)}")
```

## Configuration

The client can be configured via environment variables:

| Variable                          | Description                           | Default                         |
| --------------------------------- | ------------------------------------- | ------------------------------- |
| `OPENROUTER_API_KEY`              | API key for authentication (required) | -                               |
| `OPENROUTER_BASE_URL`             | Base URL for the API                  | `https://openrouter.ai/api/v1`  |
| `OPENROUTER_SMALL_MODEL`          | Model for small text generation       | `google/gemini-2.0-flash-001`   |
| `OPENROUTER_LARGE_MODEL`          | Model for large text generation       | `google/gemini-2.5-flash`       |
| `OPENROUTER_EMBEDDING_MODEL`      | Model for embeddings                  | `openai/text-embedding-3-small` |
| `OPENROUTER_EMBEDDING_DIMENSIONS` | Embedding dimensions                  | `1536`                          |
| `OPENROUTER_TIMEOUT_SECONDS`      | Request timeout                       | `60`                            |

## Features

- **Text Generation**: Generate text using various models (Claude, GPT, Gemini, etc.)
- **Object Generation**: Generate structured JSON objects
- **Text Embeddings**: Generate embeddings for semantic search
- **Multi-Model Support**: Access 100+ models through a single API

## Requirements

- Python 3.11+
- OpenRouter API key (https://openrouter.ai)

## License

MIT



