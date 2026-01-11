# elizaos-plugin-xai (Python)

Python package for elizaOS xAI integration.

## Installation

```bash
pip install elizaos-plugin-xai
```

## Usage

```python
from elizaos_plugin_xai import GrokClient, GrokConfig, TwitterClient, TwitterConfig

# Grok text generation
grok = GrokClient(GrokConfig.from_env())
result = await grok.generate_text(TextGenerationParams(prompt="Hello world"))
print(result.text)

# X (formerly Twitter) integration
x = TwitterClient(TwitterConfig.from_env())
me = await x.me()
print(f"@{me.username}")
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_xai

# Linting
ruff check .
ruff format .
```
