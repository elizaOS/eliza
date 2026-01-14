# elizaos-plugin-elizacloud

Python implementation of the ElizaOS Cloud plugin for multi-model AI generation.

## Installation

```bash
pip install elizaos-plugin-elizacloud
```

## Usage

```python
import asyncio
from elizaos_plugin_elizacloud import (
    ElizaCloudClient,
    ElizaCloudConfig,
    TextGenerationParams,
    TextEmbeddingParams,
    ImageGenerationParams,
)

async def main():
    # Configure the client
    config = ElizaCloudConfig(
        api_key="eliza_xxxxx",  # Get from https://www.elizacloud.ai/dashboard/api-keys
        base_url="https://www.elizacloud.ai/api/v1",
    )

    async with ElizaCloudClient(config) as client:
        # Text generation
        text = await client.generate_text(
            TextGenerationParams(prompt="What is the meaning of life?"),
            model_size="large",
        )
        print(f"Generated text: {text}")

        # Embeddings
        embedding = await client.generate_embedding(
            TextEmbeddingParams(text="Hello, world!")
        )
        print(f"Embedding dimension: {len(embedding)}")

        # Batch embeddings
        embeddings = await client.generate_embedding(
            TextEmbeddingParams(texts=["Hello", "World", "!"])
        )
        print(f"Batch embeddings: {len(embeddings)}")

        # Image generation
        images = await client.generate_image(
            ImageGenerationParams(
                prompt="A beautiful sunset over the ocean",
                count=1,
                size="1024x1024",
            )
        )
        print(f"Generated image URL: {images[0]}")

asyncio.run(main())
```

## Features

- **Text Generation**: Small (fast) and large (powerful) model support
- **Embeddings**: Single and batch text embedding with rate limit handling
- **Image Generation**: DALL-E style image generation
- **Image Description**: Vision model for describing images
- **Text-to-Speech**: Multiple voice options
- **Transcription**: Whisper-based audio transcription

## Configuration

| Setting                | Description                      | Default                            |
| ---------------------- | -------------------------------- | ---------------------------------- |
| `api_key`              | ElizaOS Cloud API key (required) | -                                  |
| `base_url`             | Base URL for API requests        | `https://www.elizacloud.ai/api/v1` |
| `small_model`          | Model for quick tasks            | `gpt-5-mini`                      |
| `large_model`          | Model for complex tasks          | `gpt-5`                           |
| `embedding_model`      | Model for embeddings             | `text-embedding-3-small`           |
| `embedding_dimensions` | Embedding vector size            | `1536`                             |

## License

MIT



