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


## Error 409: Conflict in Multiple Agents Environment

When you encounter this error in your logs:
```
error: 409: Conflict: terminated by other getUpdates request; make sure that only one bot instance is running
```

This indicates a fundamental architectural limitation with the Telegram Bot API. The Telegram API strictly enforces that only one active connection can exist per bot token at any given time. This is by design to ensure reliable message delivery and prevent message duplication or loss.

In ElizaOS multi-agent environments, this error commonly occurs when:

1. **Multiple Agents Using Same Token**: Two or more agents (such as "Eliza" and another character) each have the `@elizaos/plugin-telegram` plugin enabled in their configuration
   
2. **Simultaneous Initialization**: Each agent independently attempts to initialize its own Telegram service during startup
   
3. **Token Collision**: All agents use the same `TELEGRAM_BOT_TOKEN` from your environment configuration
   
4. **Connection Rejection**: When a second agent tries to establish a connection while another is already active, Telegram rejects it with a 409 error

This is not a bug in ElizaOS or the Telegram plugin, but rather a result of using a shared resource (the bot token) that can only accept one connection at a time.

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

## Or using bun:

```bash
bun start --character="characters/your-character.json"
```

## Utilizing Telegram Buttons

To send a message with native Telegram buttons, include an array of buttons in the message content. The following action demonstrates how to initiate a login flow using a Telegram button.

```typescript
export const initAuthHandshakeAction: Action = {
  name: 'INIT_AUTH_HANDSHAKE',
  description: 'Initiates the identity linking and authentication flow for new users.',
  validate: async (_runtime, _message, _state) => {
    return _message.content.source === 'telegram';
  },
  handler: async (runtime, message, _state, _options, callback): Promise<boolean> => {
    try {
      const user = await getUser(message.userId);
      if (user) return false;

      callback({
        text: "Let's get you set up with a new account",
        buttons: [
          {
            text: '🔑 Authenticate with Telegram',
            url: `${FRONTEND_URL}/integrations/telegram`,
            kind: 'login',
          },
        ],
      }).catch((error) => {
        console.error('Error sending callback:', error);
      });

      return true;
    } catch (error) {
      ...
    }
  },
};
```
