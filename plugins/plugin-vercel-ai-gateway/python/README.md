# elizaOS Vercel AI Gateway Plugin (Python)

Python implementation of the Vercel AI Gateway plugin for elizaOS.

## Features

- **Text Generation**: `TEXT_SMALL`, `TEXT_LARGE` chat completions
- **Embeddings**: Vector embeddings generation
- **Images**: Image generation and description
- **Structured Output**: JSON object generation
- **Streaming**: Real-time streaming support

## Installation

```bash
pip install elizaos-plugin-gateway
```

## Quick Start

```python
import asyncio
from elizaos_plugin_gateway import GatewayPlugin

async def main():
    async with GatewayPlugin() as plugin:
        # Text generation
        response = await plugin.generate_text_large("What is quantum computing?")
        print(response)

        # Embeddings
        embedding = await plugin.create_embedding("Hello, world!")
        print(f"Embedding dimensions: {len(embedding)}")

asyncio.run(main())
```

## Configuration

Set environment variables:

```bash
# Required - one of:
export AI_GATEWAY_API_KEY="your-api-key"
export AIGATEWAY_API_KEY="your-api-key"
export VERCEL_OIDC_TOKEN="your-oidc-token"

# Optional
export AI_GATEWAY_BASE_URL="https://ai-gateway.vercel.sh/v1"
export AI_GATEWAY_SMALL_MODEL="gpt-5-mini"
export AI_GATEWAY_LARGE_MODEL="gpt-5"
export AI_GATEWAY_EMBEDDING_MODEL="text-embedding-3-small"
```

## elizaOS Integration

```python
from elizaos_plugin_gateway import get_gateway_plugin

# Get the singleton plugin instance
plugin = get_gateway_plugin()

# Use with AgentRuntime
runtime = AgentRuntime(plugins=[plugin])
```

## API Reference

### GatewayPlugin

#### Text Generation

```python
await plugin.generate_text_small(prompt, system=None, max_tokens=None)
await plugin.generate_text_large(prompt, system=None, max_tokens=None)
await plugin.stream_text(prompt, model=None, system=None)
```

#### Embeddings

```python
await plugin.create_embedding(text)
```

#### Images

```python
await plugin.generate_image(prompt, n=1, size="1024x1024", quality="standard", style="vivid")
await plugin.describe_image(image_url, prompt=None, max_tokens=8192)
```

#### Structured Output

```python
await plugin.generate_object(prompt, model=None, temperature=None)
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_gateway

# Linting
ruff check .
ruff format .
```

## License

MIT



