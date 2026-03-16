# elizaos-plugin-zalo (Python)

Python implementation of the Zalo Official Account Bot API plugin for elizaOS.

## Installation

```bash
pip install elizaos-plugin-zalo
```

## Usage

```python
import asyncio
from elizaos_plugin_zalo import ZaloService, ZaloConfig

async def main():
    # Load config from environment
    config = ZaloConfig.from_env()
    
    # Create and start service
    service = ZaloService(config)
    await service.start()
    
    # Send a message
    message_id = await service.send_message("user_id", "Hello from elizaOS!")
    print(f"Sent message: {message_id}")
    
    # Stop service
    await service.stop()

asyncio.run(main())
```

## Configuration

Set the following environment variables:

- `ZALO_APP_ID` - Zalo App ID (required)
- `ZALO_SECRET_KEY` - Zalo Secret Key (required)
- `ZALO_ACCESS_TOKEN` - OAuth access token (required)
- `ZALO_REFRESH_TOKEN` - OAuth refresh token (optional)
- `ZALO_WEBHOOK_URL` - Webhook URL (required for webhook mode)
- `ZALO_USE_POLLING` - Set to `true` for polling mode (optional)
- `ZALO_ENABLED` - Set to `false` to disable (optional)
- `ZALO_PROXY_URL` - HTTP proxy URL (optional)

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_zalo

# Linting
ruff check elizaos_plugin_zalo
ruff format elizaos_plugin_zalo
```
