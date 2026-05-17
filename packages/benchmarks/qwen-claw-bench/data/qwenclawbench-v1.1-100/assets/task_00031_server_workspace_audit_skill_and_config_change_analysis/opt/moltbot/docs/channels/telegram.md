# Telegram Channel Plugin

## Setup

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Copy the bot token
3. Add to config:

```json
{
  "plugins": {
    "telegram": {
      "enabled": true,
      "token": "123456789:ABCDefGHIjklMNOpqrsTUVwxyz",
      "webhook": {
        "enabled": false,
        "url": "https://your-domain.com/api/telegram/webhook",
        "secret": "optional-secret-token"
      },
      "allowedUsers": [123456789],
      "allowedGroups": [],
      "parseMode": "MarkdownV2"
    }
  }
}
```

## Features

- Send and receive text messages
- Inline keyboards and reply markup
- Photo, document, and voice message support
- Webhook and long-polling modes
- User allowlist for access control

## Webhook vs Polling

**Polling** (default): Bot polls Telegram servers. Simpler setup, slightly higher latency.

**Webhook**: Telegram pushes updates to your server. Requires HTTPS endpoint. Lower latency.

To switch to webhook mode:
```json
"webhook": {
  "enabled": true,
  "url": "https://your-domain.com/api/telegram/webhook"
}
```

## Commands

- `/start` — Initialize bot conversation
- `/help` — Show available commands
- `/status` — Bot status check

## Rate Limits

Telegram enforces rate limits:
- 30 messages/second to different chats
- 20 messages/minute to same group
- 1 message/second to same user

The plugin handles retry logic automatically with exponential backoff.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Bot not responding | Check token validity, verify `enabled: true` |
| Webhook failures | Ensure HTTPS, check certificate chain |
| Messages not arriving | Verify `allowedUsers` includes the sender |
