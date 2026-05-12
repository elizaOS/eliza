# Telegram Plugin — Developer Reference

## Architecture

The Telegram plugin uses `node-telegram-bot-api` under the hood. Messages are routed through the Moltbot event bus.

## Message Flow

```
Telegram API → TelegramPlugin.onMessage() → EventBus.emit('message.incoming') → Router → Handler
                                                                                          ↓
Telegram API ← TelegramPlugin.sendMessage() ← EventBus.emit('message.outgoing') ← Response
```

## API Reference

### TelegramPlugin

```javascript
class TelegramPlugin {
  constructor(config)        // Initialize with plugin config
  start()                    // Begin polling/webhook
  stop()                     // Graceful shutdown
  sendMessage(chatId, text, options)  // Send a message
  sendPhoto(chatId, photo, options)   // Send a photo
  onMessage(callback)        // Register message handler
}
```

### Config Schema

```json
{
  "type": "object",
  "properties": {
    "enabled": { "type": "boolean", "default": false },
    "token": { "type": "string", "description": "Bot API token from BotFather" },
    "webhook": {
      "type": "object",
      "properties": {
        "enabled": { "type": "boolean", "default": false },
        "url": { "type": "string", "format": "uri" },
        "secret": { "type": "string" }
      }
    },
    "allowedUsers": { "type": "array", "items": { "type": "integer" } },
    "parseMode": { "type": "string", "enum": ["MarkdownV2", "HTML", "Markdown"] }
  },
  "required": ["token"]
}
```

## Events Emitted

- `telegram.message` — Raw Telegram message object
- `telegram.callback_query` — Inline keyboard callback
- `telegram.error` — API error occurred
