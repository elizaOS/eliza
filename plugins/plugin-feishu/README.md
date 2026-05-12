# Feishu/Lark Client Plugin for ElizaOS

This plugin integrates a Feishu (飞书) / Lark client with ElizaOS, allowing agents to interact via ByteDance's enterprise collaboration platform. It supports both the Chinese Feishu platform and the global Lark platform.

## Features

- **Seamless Feishu/Lark Integration**: Connects ElizaOS agents to Feishu/Lark through the Open Platform API.
- **WebSocket Real-time Events**: Receives messages and events via WebSocket for low-latency interactions.
- **Multi-region Support**: Works with both Feishu (China) and Lark (Global) platforms.
- **Configuration Validation**: Ensures required settings are properly configured before starting.
- **DM and Group Support**: Handles both direct messages and group conversations.

## Configuration Options

| Key | Type | Default | Description |
| --- | ---- | ------- | ----------- |
| `FEISHU_APP_ID` | String | Required | Application ID from Feishu/Lark Open Platform (cli_xxx format). |
| `FEISHU_APP_SECRET` | String | Required | Application secret for authentication. |
| `FEISHU_DOMAIN` | String | `"feishu"` | Domain to use: `"feishu"` for China or `"lark"` for global. |
| `FEISHU_ALLOWED_CHATS` | JSON Array | `[]` | List of chat IDs the bot is allowed to interact with. |
| `FEISHU_TEST_CHAT_ID` | String | - | Chat ID for running tests. |

## Pre-Requisites

### 1. Create a Feishu/Lark App

1. Go to the [Feishu Open Platform](https://open.feishu.cn/) or [Lark Open Platform](https://open.larksuite.com/)
2. Create a new application
3. Enable the following capabilities:
   - **Bot** - For sending and receiving messages
   - **Event Subscription** - Enable WebSocket mode for real-time events
4. Copy your App ID and App Secret from the credentials page

### 2. Configure Environment Variables

Add the following to your `.env` file:

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=your-app-secret
FEISHU_DOMAIN=feishu  # or "lark" for global
```

### 3. Configure Your Character

Create or modify your character configuration file:

```json
{
  "clients": ["feishu"],
  "settings": {
    "feishu": {
      "appId": "cli_xxx",
      "appSecret": "your-app-secret",
      "domain": "feishu"
    }
  }
}
```

## Usage

### Starting the Bot

From the project root:

```bash
npm run dev
```

Or using bun:

```bash
bun start --character="characters/your-character.json"
```

## API Endpoints

The plugin connects to the following Feishu/Lark API endpoints:

| Domain | Base URL |
| ------ | -------- |
| Feishu (China) | `https://open.feishu.cn` |
| Lark (Global) | `https://open.larksuite.com` |

## Message Types Supported

- Text messages
- Rich text (post) messages
- Interactive cards
- Image messages
- File messages

## Event Types

The plugin emits the following event types:

| Event | Description |
| ----- | ----------- |
| `FEISHU_WORLD_JOINED` | Bot joined a new chat/group |
| `FEISHU_WORLD_CONNECTED` | Bot connected successfully |
| `FEISHU_WORLD_LEFT` | Bot left a chat/group |
| `FEISHU_MESSAGE_RECEIVED` | A message was received |
| `FEISHU_MESSAGE_SENT` | A message was sent |
| `FEISHU_ENTITY_JOINED` | A user joined a chat |
| `FEISHU_ENTITY_LEFT` | A user left a chat |

## Security Best Practices

- **Production**: Restrict bot access using `FEISHU_ALLOWED_CHATS` to specify authorized chat IDs.
- **Token Management**: Keep your App Secret secure and never expose it in public repositories.
- **Webhook Verification**: The plugin automatically verifies webhook signatures from Feishu/Lark.

## Feishu vs Lark

| Feature | Feishu | Lark |
| ------- | ------ | ---- |
| Region | China | Global |
| Domain | open.feishu.cn | open.larksuite.com |
| Language | Chinese | English |
| Data Residency | China | Global |

Use `FEISHU_DOMAIN=lark` when deploying for international users.

## Troubleshooting

### Connection Issues

If you encounter connection issues:

1. Verify your App ID and App Secret are correct
2. Ensure the Bot capability is enabled in your app settings
3. Check that WebSocket event subscription is enabled
4. Verify your server can reach Feishu/Lark API endpoints

### Message Not Received

If messages are not being received:

1. Ensure the bot is added to the chat/group
2. Check that `FEISHU_ALLOWED_CHATS` includes the chat ID (or is empty for all chats)
3. Verify event subscription is properly configured

## License

MIT
