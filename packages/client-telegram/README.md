# Telegram Client Plugin for ElizaOS

This plugin integrates a Telegram client with ElizaOS, allowing characters in ElizaOS to interact via Telegram. It provides an easy setup for starting the Telegram client using the provided bot token and includes basic lifecycle management.

## Features

- **Seamless Telegram Integration**: Connects ElizaOS characters to Telegram through the bot API.
- **Configuration Validation**: Ensures required settings are properly configured before starting.
- **Startup Logging**: Logs successful initialization of the Telegram client for better debugging.
- **Future-proof Design**: Provides a basic structure for stopping the client (currently unsupported).

## Configuration Options

Here are the available configuration options for the `character.json` file:

| Key                             | Type    | Default  | Description                                                                                         |
| ------------------------------- | ------- | -------- | --------------------------------------------------------------------------------------------------- |
| `clients`                       | Array   | Required | Specifies the client type (e.g., `["telegram"]`).                                                   |
| `allowDirectMessages`           | Boolean | `false`  | Determines whether the bot should respond to direct messages (DMs).                                 |
| `shouldOnlyJoinInAllowedGroups` | Boolean | `false`  | Ensures the bot only joins and responds in specified groups.                                        |
| `allowedGroupIds`               | Array   | `[]`     | Lists the group IDs the bot is allowed to interact with (requires `shouldOnlyJoinInAllowedGroups`). |
| `messageTrackingLimit`          | Integer | `100`    | Sets the maximum number of messages to track in memory for each chat.                               |
| `templates`                     | Object  | `{}`     | Allows customization of response templates for different message scenarios.                         |

## Example `<charactername>.character.json`

Below is an example configuration file with all options:

```json
{
  "clients": ["telegram"],
  "allowDirectMessages": true,
  "shouldOnlyJoinInAllowedGroups": true,
  "allowedGroupIds": ["-123456789", "-987654321"],
  "messageTrackingLimit": 100,
  "templates": {
    "telegramMessageHandlerTemplate": "Your custom template here"
  },
  "secrets": {
    "key": "<your-bot-token>"
  }
}
```

## How to Modify Settings

1. Locate the `character.json` file in your project directory.
2. Update the file with the desired configuration options as shown in the example above.
3. Save the file and restart the bot for the changes to take effect.

## Best Practices

- **Production**: Restrict bot access with `shouldOnlyJoinInAllowedGroups: true` and specify `allowedGroupIds` to ensure security.
- **Token Management**: Always keep your bot token and backend tokens secure and never expose them in public repositories.

## Pre-Requisites

1. Add the bot token to the `.env` file in the project root:

```env
TELEGRAM_BOT_TOKEN=your-bot-token
```

2. Add the same token to your character configuration file:

Create or modify `characters/your-character.json`:

```json
{
  "clients": ["telegram"],
  "secrets": {
    "key": "<your-bot-token>"
  }
}
```

## From the project root:

```bash
npm run dev
```

## Or using pnpm:

```bash
pnpm start --character="characters/your-character.json"
```

