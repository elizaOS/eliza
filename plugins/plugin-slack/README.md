# @elizaos/plugin-slack

Slack integration for elizaOS agents: connects via Slack Socket Mode, handles inbound
events, and registers a full-featured message connector.

Set `SLACK_BOT_TOKEN` (xoxb-) and `SLACK_APP_TOKEN` (xapp-) and enable Socket Mode for
the Slack app. Configure event subscriptions and bot scopes for the required operations.
`SLACK_CHANNEL_IDS` restricts channel access; HTTP delivery additionally requires
signature validation.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-slack build  # build
bun run --cwd plugins/plugin-slack test   # tests
```
