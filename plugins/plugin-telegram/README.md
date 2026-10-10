# @elizaos/plugin-telegram

Connects an Eliza agent to Telegram via the Bot API, enabling bidirectional messaging
across private chats, groups, supergroups, channels, and forum topics.

Set `TELEGRAM_BOT_TOKEN` and enable the connector in the host. Only one live long-poller
may own a bot token. DMs default to pairing; configure `TELEGRAM_DM_POLICY` and
`TELEGRAM_ALLOWED_CHATS` deliberately. Attachment references must never expose bot
tokens.

## Replies

The bot stores inbound messages but does not answer them unless
`TELEGRAM_AUTO_REPLY=true` is set. Slash commands are always answered. Replies also
stay off while passive-connectors mode is on (`ELIZA_LIFEOPS_PASSIVE_CONNECTORS`,
on by default when the personal-assistant plugin is loaded). The service logs a
warning at startup when replies are off.

## Chat access

`TELEGRAM_DM_POLICY` accepts `pairing` (the default), `open`, `allowlist`, or
`disabled`. With no chat allowlist, pairing holds unknown DM senders for approval;
`open` allows any sender to DM the bot. Choose it only when that access is intended.

To restrict the bot, set `TELEGRAM_ALLOWED_CHATS` to a JSON array of chat ID
strings:

```sh
TELEGRAM_ALLOWED_CHATS='["123456789", "-1001234567890"]'
```

In the full bot service, a non-empty per-account `allowedChats` list takes
precedence over `TELEGRAM_ALLOWED_CHATS`. Otherwise, the global allowlist is
authoritative for DMs, groups, channels, and topics.
A malformed value blocks all chats until corrected. An unset or empty string
leaves non-private chats open and applies `TELEGRAM_DM_POLICY` to private chats;
the valid JSON value `[]` instead denies every chat. Set `TELEGRAM_DM_POLICY`
to `allowlist` only when an allowlist is configured.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-telegram build  # build
bun run --cwd plugins/plugin-telegram test   # tests
```
