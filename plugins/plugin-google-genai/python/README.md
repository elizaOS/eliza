# elizaOS Google GenAI Plugin (Python)

Python implementation of the elizaOS Google Generative AI plugin for Gemini models.

## Installation

```bash
pip install elizaos-plugin-google-genai
```

## Quick Start

```python
import asyncio
from elizaos_plugin_google_genai import GoogleGenAIClient, GoogleGenAIConfig

async def main():
    # Load config from environment
    config = GoogleGenAIConfig.from_env()

    async with GoogleGenAIClient(config) as client:
        # Generate text
        response = await client.generate_text_large("What is the meaning of life?")
        print(response.text)

        # Generate embeddings
        embedding = await client.generate_embedding("Hello, world!")
        print(f"Embedding dimension: {len(embedding.embedding)}")

        # Generate structured JSON
        from elizaos_plugin_google_genai import ObjectGenerationParams

        result = await client.generate_object_small(ObjectGenerationParams(
            prompt="Generate a person profile with name and age",
            json_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "age": {"type": "number"}
                }
            }
        ))
        print(result.object)

asyncio.run(main())
```

## Configuration

Set the following environment variables:

| Variable                       | Required | Description                                                  |
| ------------------------------ | -------- | ------------------------------------------------------------ |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Yes      | Your Google AI API key                                       |
| `GOOGLE_SMALL_MODEL`           | No       | Override small model (default: gemini-2.0-flash-001)         |
| `GOOGLE_LARGE_MODEL`           | No       | Override large model (default: gemini-2.5-pro-preview-03-25) |
| `GOOGLE_EMBEDDING_MODEL`       | No       | Override embedding model (default: text-embedding-004)       |
| `GOOGLE_IMAGE_MODEL`           | No       | Override image model                                         |
| `GOOGLE_TIMEOUT_SECONDS`       | No       | Request timeout (default: 60)                                |

## Features

- **Text Generation**: Generate text using Gemini models
- **Embeddings**: Generate text embeddings for semantic search
- **Image Analysis**: Analyze and describe images
- **JSON Object Generation**: Generate structured JSON with schema validation
- **Async/Await**: Full async support for efficient I/O
- **Type Safety**: Full type hints with Pydantic models

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_google_genai

# Linting
ruff check .
ruff format .
```

## License

MIT



