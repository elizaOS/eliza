# elizaOS Plugin: Zalo User (Python)

Zalo Personal Account integration for elizaOS agents via zca-cli.

## Overview

This plugin enables elizaOS agents to interact with Zalo personal accounts using the zca-cli tool. It supports:

- QR code login flow
- Direct messages (DMs) and group messages
- Multi-profile support
- Friend and group listing
- Media sending (images, links)

## Prerequisites

You must have [zca-cli](https://github.com/nickvt99/zca-cli) installed:

```bash
npm install -g zca-cli
```

Then authenticate with your Zalo account:

```bash
zca auth login
```

## Installation

```bash
pip install elizaos-plugin-zalouser
```

## Configuration

Set the following environment variables:

| Variable | Description | Required |
|----------|-------------|----------|
| `ZALOUSER_ENABLED` | Enable/disable the plugin | No (default: `true`) |
| `ZALOUSER_DEFAULT_PROFILE` | Default zca profile to use | No (default: `default`) |
| `ZALOUSER_COOKIE_PATH` | Path to cookie file for auth persistence | No |
| `ZALOUSER_IMEI` | IMEI for authentication | No |
| `ZALOUSER_USER_AGENT` | User agent for API requests | No |
| `ZALOUSER_PROFILES` | JSON config for multiple profiles | No |
| `ZALOUSER_ALLOWED_THREADS` | JSON array or comma-separated list of allowed thread IDs | No |
| `ZALOUSER_DM_POLICY` | DM policy: `open`, `allowlist`, `pairing`, `disabled` | No (default: `pairing`) |
| `ZALOUSER_GROUP_POLICY` | Group policy: `open`, `allowlist`, `disabled` | No (default: `disabled`) |
| `ZALOUSER_LISTEN_TIMEOUT` | Listen timeout in ms | No (default: `30000`) |

## Usage

```python
from elizaos_plugin_zalouser import ZaloUserService, ZaloUserConfig, SendMessageParams

# Create config
config = ZaloUserConfig.from_env()

# Create and start service
service = ZaloUserService(config)
await service.start()

# Send a message
result = await service.send_message(
    SendMessageParams(
        threadId="123456789",
        text="Hello from elizaOS!",
    )
)

# List friends
friends = await service.list_friends()

# List groups
groups = await service.list_groups()

# Stop service
await service.stop()
```

## License

MIT
