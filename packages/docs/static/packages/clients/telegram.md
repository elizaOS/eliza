# Telegram Client Plugin for ElizaOS

## Purpose

This plugin integrates a Telegram client with ElizaOS, allowing characters in ElizaOS to interact via Telegram.

## Key Features

- Seamless Telegram Integration
- Configuration Validation
- Startup Logging
- Future-proof Design

## Configuration

| Key                             | Type    | Default  | Description                                                                 |
| ------------------------------- | ------- | -------- | --------------------------------------------------------------------------- |
| `clients`                       | Array   | Required | Specifies the client type (e.g., `["telegram"]`).                           |
| `allowDirectMessages`           | Boolean | `false`  | Determines whether the bot should respond to direct messages.               |
| `shouldOnlyJoinInAllowedGroups` | Boolean | `false`  | Ensures the bot only joins and responds in specified groups.                |
| `allowedGroupIds`               | Array   | `[]`     | Lists the group IDs the bot is allowed to interact with.                    |
| `messageTrackingLimit`          | Integer | `100`    | Sets the maximum number of messages to track in memory for each chat.       |
| `templates`                     | Object  | `{}`     | Allows customization of response templates for different message scenarios. |

## Integration

The plugin connects ElizaOS characters to Telegram through the bot API, allowing them to interact via Telegram.

## Example Usage

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
