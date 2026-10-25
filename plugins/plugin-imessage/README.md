# @elizaos/plugin-imessage

iMessage connector for Eliza agents using native macOS Messages or a channel-isolated
Blooio webhook and API transport.

Native mode requires macOS Messages access and the relevant OS permissions. For Linux
use `IMESSAGE_TRANSPORT=blooio` with `IMESSAGE_BLOOIO_API_KEY`,
`IMESSAGE_BLOOIO_WEBHOOK_SECRET`, `IMESSAGE_BLOOIO_FROM_NUMBER`, and
`IMESSAGE_BLOOIO_CHANNEL_ID`. Point the channel webhook at
`/api/imessage/webhook/blooio`; preserve raw-body signature verification and channel
isolation.

Native mode requires macOS Messages, Full Disk Access for history, and Automation permission for sending. Blooio mode uses its configured channel and API credentials and can run on Linux.

The connector stores inbound messages but does not reply, and does not send DM pairing
codes, unless `IMESSAGE_AUTO_REPLY=true` is set. This applies to both transports.
Replies also stay off while passive-connectors mode is on
(`ELIZA_LIFEOPS_PASSIVE_CONNECTORS`, on by default when the personal-assistant plugin
is loaded). The service logs a warning at startup when replies are off.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-imessage build  # build
bun run --cwd plugins/plugin-imessage test   # tests
```
