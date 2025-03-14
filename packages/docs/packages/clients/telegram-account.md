# Client Telegram Account

The Telegram Account Plugin allows ElizaOS agents to connect and operate through a real Telegram account, enabling your agent to participate in Telegram chats, groups, and direct messages as a regular user.

## Features

- Connect to any Telegram account using API credentials
- Receive and respond to direct messages
- Participate in group chats when mentioned (@username)
- Reply to messages that reply to the account
- Support for multi-part messages (automatically splits long messages)
- Proper Markdown formatting in responses
- Media attachment support

## Prerequisites

Before using this plugin, you need:

1. A Telegram account with an active phone number
2. Telegram API credentials (App ID and App Hash)
3. ElizaOS installed and configured

## Setup

### 1. Get Telegram API Credentials

1. Visit [https://my.telegram.org/apps](https://my.telegram.org/apps)
2. Log in with your Telegram account phone number
3. Create a new application if you don't have one already
4. Note down the **App api_id** and **App api_hash**

### 2. Configure the Plugin

Add the following environment variables to your ElizaOS configuration:

```
TELEGRAM_ACCOUNT_PHONE="+1234567890"  # Your phone number with country code
TELEGRAM_ACCOUNT_APP_ID=12345         # Your Telegram API app_id
TELEGRAM_ACCOUNT_APP_HASH="your_api_hash_here"
TELEGRAM_ACCOUNT_DEVICE_MODEL="Desktop"  # Device model to show in Telegram
TELEGRAM_ACCOUNT_SYSTEM_VERSION="1.0"   # System version to show in Telegram
```

### 3. Install the Plugin

To install the plugin to your ElizaOS agent:

```bash
npm install @elizaos-plugins/client-telegram-account
```

### 4. Add the Plugin to Your Agent Configuration

Add the Telegram Account client to your agent's configuration:

```json
{
  "clients": [
    "telegramAccount"
  ]
}
```

### 5. First-time Authentication

When running your agent for the first time with this plugin:

1. The plugin will prompt you to enter the authentication code sent to your Telegram account
2. Enter the code to authenticate your session
3. The session will be saved for future use

## Usage

Once configured, your agent will:

- Respond to direct messages automatically
- Respond in groups when specifically mentioned with @username
- Respond to replies to its own messages
- Process incoming media files
- Format responses using Markdown
- Split long messages into multiple parts if necessary

## Configuration Options

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `TELEGRAM_ACCOUNT_PHONE` | Yes | Phone number with country code |
| `TELEGRAM_ACCOUNT_APP_ID` | Yes | Telegram API application ID |
| `TELEGRAM_ACCOUNT_APP_HASH` | Yes | Telegram API application hash |
| `TELEGRAM_ACCOUNT_DEVICE_MODEL` | Yes | Device model shown to other users |
| `TELEGRAM_ACCOUNT_SYSTEM_VERSION` | Yes | System version shown to other users |

## Security Considerations

- Store your Telegram API credentials securely as they provide full access to your account
- The plugin stores the authentication session in `./data/telegram_account_session` directory
- Be mindful of rate limits and Telegram's terms of service

## Troubleshooting

### Authentication Issues

If you encounter authentication problems:

1. Make sure your app ID and hash are correct
2. Delete the session file in `./data/telegram_account_session` to reset authentication
3. Ensure your phone number is in the correct format (with country code)

### Response Problems

If your agent is not responding properly:

1. Check if the agent has the correct username in Telegram
2. Verify the agent is being mentioned properly in groups with @username
3. Examine the logs for any error messages

## Limitations

- The agent can only respond, it cannot initiate conversations
- In groups, it requires an explicit mention (@username) to respond
- Cannot currently handle voice messages or stickers
