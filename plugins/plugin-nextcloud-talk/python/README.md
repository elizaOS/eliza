# elizaOS Nextcloud Talk Plugin (Python)

Python implementation of the Nextcloud Talk plugin for elizaOS.

## Features

- Webhook bot integration with Nextcloud Talk
- HMAC-SHA256 signature verification
- Bot secret authentication
- Support for DMs and group chats
- Reactions support

## Installation

```bash
pip install elizaos-plugin-nextcloud-talk
```

## Configuration

Set these environment variables:

- NEXTCLOUD_URL - Base URL of your Nextcloud instance
- NEXTCLOUD_BOT_SECRET - Bot secret from occ talk:bot:install

Optional:
- NEXTCLOUD_ENABLED - Enable/disable plugin (default: true)
- NEXTCLOUD_WEBHOOK_PORT - Webhook port (default: 8788)
- NEXTCLOUD_WEBHOOK_HOST - Webhook host (default: 0.0.0.0)
- NEXTCLOUD_WEBHOOK_PATH - Webhook path (default: /nextcloud-talk-webhook)

## License

MIT
