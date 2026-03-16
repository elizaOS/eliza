# elizaos-plugin-anthropic

Python implementation of the Anthropic Claude API client for elizaOS.

## Features

- Text generation with Claude models
- Structured JSON object generation
- Strong types with Pydantic models
- Fail-fast error handling
- Async/await support with httpx

## Installation

```bash
pip install elizaos-plugin-anthropic
```

## Usage

### Text Generation

```python
import asyncio
from elizaos_plugin_anthropic import AnthropicClient, AnthropicConfig, TextGenerationParams

async def main():
    config = AnthropicConfig.from_env()
    async with AnthropicClient(config) as client:
        # Simple prompt
        response = await client.generate_text_large("What is the meaning of life?")
        print(f"Response: {response.text}")

        # With parameters
        params = (
            TextGenerationParams(prompt="Explain quantum computing")
            .with_max_tokens(1024)
            .with_temperature(0.7)
        )
        response = await client.generate_text_large(params)
        print(f"Tokens used: {response.usage.total_tokens()}")

asyncio.run(main())
```

### JSON Object Generation

```python
import asyncio
from elizaos_plugin_anthropic import AnthropicClient, AnthropicConfig, ObjectGenerationParams

async def main():
    config = AnthropicConfig.from_env()
    async with AnthropicClient(config) as client:
        # Simple prompt
        response = await client.generate_object_small(
            "Create a JSON object with name, age, and email fields"
        )
        print(f"Generated: {response.object}")

        # With parameters
        params = ObjectGenerationParams(
            prompt="Create a user profile with nested address",
            temperature=0.2,
        )
        response = await client.generate_object_large(params)
        print(f"User: {response.object}")

asyncio.run(main())
```

## Configuration

Environment variables:

| Variable                    | Required | Default                     | Description            |
| --------------------------- | -------- | --------------------------- | ---------------------- |
| `ANTHROPIC_API_KEY`         | Yes      | -                           | Your Anthropic API key |
| `ANTHROPIC_BASE_URL`        | No       | `https://api.anthropic.com` | API base URL           |
| `ANTHROPIC_SMALL_MODEL`     | No       | `claude-3-5-haiku-20241022` | Small model ID         |
| `ANTHROPIC_LARGE_MODEL`     | No       | `claude-sonnet-4-20250514`  | Large model ID         |
| `ANTHROPIC_TIMEOUT_SECONDS` | No       | `60`                        | Request timeout        |

## Models

Available models:

| Model                        | Size  | Description          |
| ---------------------------- | ----- | -------------------- |
| `claude-3-5-haiku-20241022`  | Small | Fast and efficient   |
| `claude-sonnet-4-20250514`   | Large | Most capable         |
| `claude-3-5-sonnet-20241022` | Large | Balanced performance |
| `claude-3-opus-20240229`     | Large | Previous flagship    |

## Testing

Install development dependencies:

```bash
pip install -e ".[dev]"
```

Run unit tests:

```bash
pytest -v
```

Run integration tests (requires API key):

```bash
# Create .env file with your API key
echo "ANTHROPIC_API_KEY=your-key" > .env

# Run integration tests
pytest -m integration
```

## Type Checking

```bash
mypy elizaos_plugin_anthropic
```

## License

MIT
