# elizaOS Telegram Plugin (Python)

Telegram bot integration for elizaOS agents.

## Features

- Telegram bot message handling
- Support for private chats, groups, and supergroups
- Forum topic support for supergroups
- Entity synchronization
- Reaction handling
- Button support (login and URL buttons)

## Installation

```bash
pip install elizaos-plugin-telegram
```

## Configuration

The plugin requires the following environment variables:

- `TELEGRAM_BOT_TOKEN` (required): Your Telegram Bot API token
- `TELEGRAM_API_ROOT` (optional): Custom API root URL (default: `https://api.telegram.org`)
- `TELEGRAM_ALLOWED_CHATS` (optional): JSON array of allowed chat IDs

## Usage

```python
from elizaos_plugin_telegram import TelegramService, TelegramConfig

# Create configuration
config = TelegramConfig.from_env()

# Initialize service
service = TelegramService(config)

# Start the bot
await service.start()
```

## Event Types

The plugin emits the following event types:

- `TELEGRAM_WORLD_JOINED` - Bot joined a new chat
- `TELEGRAM_WORLD_CONNECTED` - Bot connected to existing chat
- `TELEGRAM_WORLD_LEFT` - Bot left a chat
- `TELEGRAM_ENTITY_JOINED` - User joined a chat
- `TELEGRAM_ENTITY_LEFT` - User left a chat
- `TELEGRAM_ENTITY_UPDATED` - User information updated
- `TELEGRAM_MESSAGE_RECEIVED` - Message received
- `TELEGRAM_MESSAGE_SENT` - Message sent
- `TELEGRAM_REACTION_RECEIVED` - Reaction received
- `TELEGRAM_SLASH_START` - /start command received

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_telegram

# Linting
ruff check elizaos_plugin_telegram
ruff format elizaos_plugin_telegram
```

## License

MIT
