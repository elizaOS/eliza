# elizaOS Roblox Plugin - Python Implementation

Python implementation of the Roblox plugin for elizaOS, enabling game communication via the Roblox Open Cloud API.

## Features

- **Messaging Service**: Cross-server communication with Roblox games
- **DataStore**: Persistent data storage operations
- **User Lookup**: Get player information by ID or username
- **Experience Info**: Retrieve universe/experience metadata
- **Dry Run Mode**: Test without making actual API calls
- **Fully Typed**: Complete type annotations with Pydantic models

## Installation

```bash
pip install elizaos-plugin-roblox
```

Or with development dependencies:

```bash
pip install elizaos-plugin-roblox[dev]
```

## Usage

```python
import asyncio
from uuid import uuid4
from elizaos_plugin_roblox import RobloxConfig, RobloxService

async def main():
    # Create config from environment or manually
    config = RobloxConfig.from_env()
    # Or: RobloxConfig(api_key="your-key", universe_id="12345")

    # Create and start service
    async with RobloxService(config, uuid4(), "MyAgent") as service:
        # Send a message to the game
        await service.send_message("Hello from Eliza!")

        # Execute a game action
        await service.execute_action(
            "spawn_item",
            {"item": "sword", "rarity": "legendary"},
            target_player_ids=[12345678],
        )

asyncio.run(main())
```

## Configuration

### Environment Variables

| Variable                 | Required | Description                              |
| ------------------------ | -------- | ---------------------------------------- |
| `ROBLOX_API_KEY`         | Yes      | Roblox Open Cloud API key                |
| `ROBLOX_UNIVERSE_ID`     | Yes      | Universe ID of the experience            |
| `ROBLOX_PLACE_ID`        | No       | Specific place ID                        |
| `ROBLOX_WEBHOOK_SECRET`  | No       | Secret for webhook validation            |
| `ROBLOX_MESSAGING_TOPIC` | No       | Messaging topic (default: "eliza-agent") |
| `ROBLOX_POLL_INTERVAL`   | No       | Poll interval in seconds (default: 30)   |
| `ROBLOX_DRY_RUN`         | No       | Enable dry run mode (default: false)     |

## API Reference

### RobloxClient

Low-level API client:

```python
from elizaos_plugin_roblox import RobloxClient, RobloxConfig

async with RobloxClient(config) as client:
    # Messaging
    await client.publish_message("topic", data)
    await client.send_agent_message(message)

    # DataStore
    entry = await client.get_datastore_entry("store", "key")
    await client.set_datastore_entry("store", "key", value)
    await client.delete_datastore_entry("store", "key")

    # Users
    user = await client.get_user_by_id(12345678)
    user = await client.get_user_by_username("PlayerName")
    avatar = await client.get_avatar_url(12345678)

    # Experience
    info = await client.get_experience_info()
```

### RobloxService

High-level service for elizaOS integration:

```python
from elizaos_plugin_roblox import RobloxService

async with RobloxService(config, agent_id, "AgentName") as service:
    await service.send_message("Hello!")
    await service.execute_action("action_name", params)
```

## Development

### Setup

```bash
pip install -e ".[dev]"
```

### Testing

```bash
pytest
```

### Type Checking

```bash
mypy elizaos_plugin_roblox
```

### Linting

```bash
ruff check .
ruff format .
```

## License

MIT



