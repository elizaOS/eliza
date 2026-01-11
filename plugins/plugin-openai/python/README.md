# elizaOS OpenAI Plugin (Python)

A type-safe async Python client for OpenAI APIs, designed for use with elizaOS.

## Features

- 🔒 **Strong typing** with Pydantic validation
- ⚡ **Async-first** using httpx
- 🎯 **Fail-fast** error handling - no silent failures
- 📝 **Full API coverage**:
  - Text generation (GPT-4, GPT-4o, etc.)
  - Embeddings (text-embedding-3-small, etc.)
  - Image generation (DALL-E)
  - Image description (GPT-4 Vision)
  - Audio transcription (Whisper)
  - Text-to-speech
  - Tokenization (tiktoken)

## Installation

```bash
pip install elizaos-plugin-openai
```

## Quick Start

```python
import asyncio
from elizaos_plugin_openai import OpenAIPlugin

async def main():
    # Create plugin (uses OPENAI_API_KEY env var by default)
    async with OpenAIPlugin() as plugin:
        # Generate text
        response = await plugin.generate_text_large(
            "Explain quantum computing in 2 sentences."
        )
        print(response)

        # Create embedding
        embedding = await plugin.create_embedding("Hello, world!")
        print(f"Embedding dimensions: {len(embedding)}")

        # Describe an image
        description = await plugin.describe_image(
            "https://example.com/image.jpg"
        )
        print(f"Title: {description.title}")
        print(f"Description: {description.description}")

asyncio.run(main())
```

## Configuration

```python
from elizaos_plugin_openai import OpenAIPlugin

plugin = OpenAIPlugin(
    api_key="sk-...",  # Or use OPENAI_API_KEY env var
    base_url="https://api.openai.com/v1",
    small_model="gpt-5-mini",
    large_model="gpt-5",
    embedding_model="text-embedding-3-small",
    embedding_dimensions=1536,
)
```

## Streaming

```python
async with OpenAIPlugin() as plugin:
    async for chunk in plugin.stream_text("Tell me a story..."):
        print(chunk, end="", flush=True)
```

## Tokenization

```python
from elizaos_plugin_openai import tokenize, detokenize, count_tokens

# Count tokens
count = count_tokens("Hello, world!", model="gpt-5")
print(f"Token count: {count}")

# Tokenize and detokenize
tokens = tokenize("Hello, world!", model="gpt-5")
text = detokenize(tokens, model="gpt-5")
```

## Error Handling

All API errors are raised as `OpenAIClientError`:

```python
from elizaos_plugin_openai import OpenAIPlugin, OpenAIClientError

async with OpenAIPlugin() as plugin:
    try:
        result = await plugin.generate_text_large("...")
    except OpenAIClientError as e:
        print(f"API error ({e.status_code}): {e}")
```

## License

MIT
