# @elizaos/plugin-x

X (formerly Twitter) connector for elizaOS agents: posting, mentions, replies, DMs,
timeline actions, and autonomous content discovery.

Configure `TWITTER_AUTH_MODE` and its credentials: env uses API key/secret and access
token/secret; oauth uses `TWITTER_CLIENT_ID` and `TWITTER_REDIRECT_URI`; broker uses the
managed account transport. Autonomous posting/actions are opt-in. DMs default to
pairing. Tokens remain account-scoped in runtime storage.

For credential-free reads, compose `@elizaos/plugin-x/public` separately.
`READ_PUBLIC_X_POST` checks the official oEmbed author and corroborates its
calendar date with the status ID. It does not start authenticated account
services, read private timelines, or guarantee the latest account post.
`DISCOVER_PUBLIC_X_POSTS` checks matching public profile titles, reads indexed
post candidates through official oEmbed, and orders verified posts by date.
Its source receipt and coverage gaps stay available with the result.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-x build  # build
bun run --cwd plugins/plugin-x test   # tests
```
