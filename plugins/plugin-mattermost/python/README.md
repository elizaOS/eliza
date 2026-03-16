# elizaos-plugin-mattermost (Python)

Python implementation of the Mattermost plugin for elizaOS.

## Installation

```bash
pip install elizaos-plugin-mattermost
```

## Quick Start

```python
import asyncio
from elizaos_plugin_mattermost import MattermostConfig, MattermostService, MattermostContent

async def main():
    # Create config from environment variables
    config = MattermostConfig.from_env()
    
    # Or create config manually
    config = MattermostConfig(
        server_url="https://chat.example.com",
        bot_token="your-bot-token",
    )
    
    # Create and start service
    service = MattermostService(config)
    await service.start()
    
    # Register message handler
    def on_message(payload):
        print(f"Received message: {payload.post.message}")
    
    service.on_message(on_message)
    
    # Send a message
    content = MattermostContent(text="Hello from Python!")
    await service.send_message("channel_id", content)
    
    # Keep running
    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        await service.stop()

asyncio.run(main())
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Run linter
ruff check .
ruff format .
```

## License

MIT
