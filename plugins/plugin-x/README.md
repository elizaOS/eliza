# @elizaos/plugin-x

X (formerly Twitter) connector for elizaOS agents: posting, mentions, replies, DMs,
timeline actions, and autonomous content discovery.

Configure `TWITTER_AUTH_MODE` and its credentials: env uses API key/secret and access
token/secret; oauth uses `TWITTER_CLIENT_ID` and `TWITTER_REDIRECT_URI`; broker uses the
managed account transport. Autonomous posting/actions are opt-in. DMs default to
pairing. Tokens remain account-scoped in runtime storage.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-x build  # build
bun run --cwd plugins/plugin-x test   # tests
```
