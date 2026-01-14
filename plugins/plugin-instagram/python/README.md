# elizaOS Instagram Plugin (Python)

Instagram integration for elizaOS agents.

## Features

- Instagram direct message handling
- Post and story interactions
- Comment management
- Media upload support
- User profile interactions

## Installation

```bash
pip install elizaos-plugin-instagram
```

## Configuration

The plugin requires the following environment variables:

- `INSTAGRAM_USERNAME` (required): Your Instagram username
- `INSTAGRAM_PASSWORD` (required): Your Instagram password
- `INSTAGRAM_VERIFICATION_CODE` (optional): 2FA verification code if enabled

## Usage

```python
from elizaos_plugin_instagram import InstagramService, InstagramConfig

# Create configuration
config = InstagramConfig.from_env()

# Initialize service
service = InstagramService(config)

# Start the service
await service.start()
```

## Event Types

The plugin emits the following event types:

- `INSTAGRAM_MESSAGE_RECEIVED` - Direct message received
- `INSTAGRAM_MESSAGE_SENT` - Direct message sent
- `INSTAGRAM_COMMENT_RECEIVED` - Comment on post received
- `INSTAGRAM_LIKE_RECEIVED` - Like on post received
- `INSTAGRAM_FOLLOW_RECEIVED` - New follower

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_instagram

# Linting
ruff check elizaos_plugin_instagram
ruff format elizaos_plugin_instagram
```

## License

MIT
