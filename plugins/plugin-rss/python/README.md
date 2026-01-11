# elizaos-plugin-rss

Python implementation of the RSS plugin for elizaOS.

## Installation

```bash
pip install elizaos-plugin-rss
```

Or for development:

```bash
pip install -e ".[dev]"
```

## Usage

```python
from elizaos_plugin_rss import RssClient, RssConfig

# Create client
config = RssConfig()
client = RssClient(config)

# Fetch a feed
feed = await client.fetch_feed("https://news.ycombinator.com/rss")
print(f"Feed: {feed.title}")
print(f"Items: {len(feed.items)}")

for item in feed.items[:5]:
    print(f"  - {item.title}")
```

## Features

- Async HTTP client using httpx
- Type-safe with Pydantic models
- RSS 2.0 and Atom feed parsing
- Secure XML parsing with defusedxml
- Full feature parity with TypeScript and Rust implementations

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_rss

# Linting
ruff check .
ruff format .
```

## License

MIT



