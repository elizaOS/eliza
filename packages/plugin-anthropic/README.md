# Anthropic Plugin

This plugin provides integration with Anthropic's Claude models through the ElizaOS platform.

## Usage

Add the plugin to your character configuration:

```json
"plugins": ["@elizaos/plugin-anthropic"]
```

## Configuration

The plugin requires these environment variables (can be set in .env file or character settings):

```json
"settings": {
  "ANTHROPIC_API_KEY": "your_anthropic_api_key",
  "ANTHROPIC_SMALL_MODEL": "claude-3-5-haiku-latest",
  "ANTHROPIC_LARGE_MODEL": "claude-3-5-sonnet-latest"
}
```

Or in `.env` file:

```
ANTHROPIC_API_KEY=your_anthropic_api_key
# Optional overrides:
ANTHROPIC_SMALL_MODEL=claude-3-5-haiku-latest
ANTHROPIC_LARGE_MODEL=claude-3-5-sonnet-latest
```

### Configuration Options

- `ANTHROPIC_API_KEY` (required): Your Anthropic API credentials
- `ANTHROPIC_SMALL_MODEL`: Defaults to Claude 3 Haiku ("claude-3-5-haiku-latest")
- `ANTHROPIC_LARGE_MODEL`: Defaults to Claude 3 Sonnet ("claude-3-5-sonnet-latest")

The plugin provides two model classes:

- `TEXT_SMALL`: Optimized for fast, cost-effective responses
- `TEXT_LARGE`: For more complex tasks requiring deeper reasoning
