# elizaOS Discord Plugin (Python)

Python implementation of the Discord plugin for elizaOS agents.

## Installation

```bash
pip install elizaos-plugin-discord
```

For voice support:

```bash
pip install elizaos-plugin-discord[voice]
```

## Quick Start

```python
import asyncio
from elizaos_plugin_discord import DiscordConfig, DiscordService

async def main():
    # Load config from environment
    config = DiscordConfig.from_env()

    # Create and start the service
    service = DiscordService(config)

    # Set up event handler
    @service.on_message
    async def handle_message(message):
        print(f"Received: {message.content}")

    # Start the bot
    await service.start()

asyncio.run(main())
```

## Configuration

Set the following environment variables:

| Variable                                  | Required | Description                                     |
| ----------------------------------------- | -------- | ----------------------------------------------- |
| `DISCORD_API_TOKEN`                       | Yes      | Bot token from Discord Developer Portal         |
| `DISCORD_APPLICATION_ID`                  | Yes      | Application ID from Discord Developer Portal    |
| `CHANNEL_IDS`                             | No       | Comma-separated list of channel IDs to monitor  |
| `DISCORD_SHOULD_IGNORE_BOT_MESSAGES`      | No       | Ignore messages from other bots (default: true) |
| `DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES`   | No       | Ignore DMs (default: false)                     |
| `DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS` | No       | Only respond when mentioned (default: false)    |

## Actions

- `send_message` - Send a message to a channel
- `send_dm` - Send a direct message to a user
- `add_reaction` - Add a reaction to a message

## Providers

- `channel_state` - Current channel information
- `voice_state` - Voice channel state
- `guild_info` - Server/guild information

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_discord

# Linting
ruff check elizaos_plugin_discord
```

## License

MIT
