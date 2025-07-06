# Client Telegram Account

## Purpose

The Telegram Account Plugin allows ElizaOS agents to connect and operate through a real Telegram account, enabling your agent to participate in Telegram chats, groups, and direct messages as a regular user.

## Key Features

- Connect to any Telegram account using API credentials
- Receive and respond to direct messages
- Participate in group chats when mentioned (@username)
- Reply to messages that reply to the account
- Support for multi-part messages (automatically splits long messages)
- Proper Markdown formatting in responses
- Media attachment support

## Prerequisites

- A Telegram account with an active phone number
- Telegram API credentials (App ID and App Hash)
- ElizaOS installed and configured

## Installation

```bash
bun install @elizaos-plugins/client-telegram-account
```

## Configuration

Environment variables:

```
TELEGRAM_ACCOUNT_PHONE="+1234567890"
TELEGRAM_ACCOUNT_APP_ID=12345
TELEGRAM_ACCOUNT_APP_HASH="your_api_hash_here"
TELEGRAM_ACCOUNT_DEVICE_MODEL="Desktop"
TELEGRAM_ACCOUNT_SYSTEM_VERSION="1.0"
```

Add to agent configuration:

```json
{
  "clients": ["telegramAccount"]
}
```

## Integration

Once configured, your agent will:

- Respond to direct messages automatically
- Respond in groups when specifically mentioned with @username
- Respond to replies to its own messages
- Process incoming media files
- Format responses using Markdown
- Split long messages into multiple parts if necessary
