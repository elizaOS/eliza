# @elizaos/plugin-telegram

Connects an Eliza agent to Telegram via the Bot API, enabling bidirectional messaging
across private chats, groups, supergroups, channels, and forum topics.

Set `TELEGRAM_BOT_TOKEN` and enable the connector in the host. Only one live long-poller
may own a bot token. DMs default to pairing; configure `TELEGRAM_DM_POLICY` and
`TELEGRAM_ALLOWED_CHATS` deliberately. Attachment references must never expose bot
tokens.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-telegram build  # build
bun run --cwd plugins/plugin-telegram test   # tests
```
