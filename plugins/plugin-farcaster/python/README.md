# elizaOS Farcaster Plugin - Python

A Python implementation of the Farcaster plugin for elizaOS, providing full integration with the Farcaster decentralized social network via the Neynar API.

## Features

- **Cast Management**: Send casts, reply to casts, and manage your timeline
- **Profile Management**: Fetch and cache user profiles
- **Mentions & Notifications**: Monitor and respond to mentions
- **Timeline Provider**: Access your Farcaster feed
- **Thread Support**: Navigate and respond within cast threads
- **Embed Processing**: Handle images, videos, and embedded casts

## Installation

```bash
pip install elizaos-plugin-farcaster
```

Or with development dependencies:

```bash
pip install elizaos-plugin-farcaster[dev]
```

## Configuration

The plugin requires the following environment variables:

| Variable                   | Required | Description                                               |
| -------------------------- | -------- | --------------------------------------------------------- |
| `FARCASTER_FID`            | Yes      | Your Farcaster ID (FID)                                   |
| `FARCASTER_SIGNER_UUID`    | Yes      | Neynar signer UUID for signing casts                      |
| `FARCASTER_NEYNAR_API_KEY` | Yes      | Neynar API key for API access                             |
| `FARCASTER_DRY_RUN`        | No       | Enable dry run mode (default: false)                      |
| `FARCASTER_MODE`           | No       | Operation mode: 'polling' or 'webhook' (default: polling) |
| `MAX_CAST_LENGTH`          | No       | Maximum cast length (default: 320)                        |
| `FARCASTER_POLL_INTERVAL`  | No       | Polling interval in seconds (default: 120)                |

## Usage

### Basic Usage

```python
from elizaos_plugin_farcaster import FarcasterClient, FarcasterConfig

# Load configuration from environment
config = FarcasterConfig.from_env()

# Create client
client = FarcasterClient(config)

# Send a cast
async def main():
    cast = await client.send_cast("Hello from elizaOS! 🤖")
    print(f"Cast sent: {cast.hash}")

    # Get your profile
    profile = await client.get_profile(config.fid)
    print(f"Username: {profile.username}")

# Run
import asyncio
asyncio.run(main())
```

### With elizaOS Runtime

```python
from elizaos_plugin_farcaster import farcaster_plugin

# Register with agent runtime
runtime.register_plugin(farcaster_plugin)
```

## Development

### Running Tests

```bash
cd python
pytest
```

### Type Checking

```bash
mypy elizaos_plugin_farcaster
```

### Linting

```bash
ruff check .
ruff format .
```

## API Reference

### FarcasterClient

The main client for interacting with Farcaster via Neynar.

- `send_cast(text, reply_to=None)` - Send a new cast
- `get_cast(hash)` - Get a cast by hash
- `get_profile(fid)` - Get a user profile by FID
- `get_mentions(limit=20)` - Get mentions for the configured FID
- `get_timeline(limit=50)` - Get the user's timeline

### Types

- `Cast` - Represents a Farcaster cast
- `Profile` - Represents a Farcaster user profile
- `CastEmbed` - Represents embedded content in a cast
- `FarcasterConfig` - Configuration for the Farcaster client

## License

MIT License - see LICENSE file for details.
