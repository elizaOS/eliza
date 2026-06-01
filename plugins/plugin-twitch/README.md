# @elizaos/plugin-twitch

Twitch chat integration for elizaOS agents. Connects to one or more Twitch
channels over IRC (via [@twurple](https://twurple.js.org)), receives chat
messages with role-based filtering and optional @mention gating, and sends
replies. Outbound send/join/leave operations route through the runtime
`MESSAGE` action via a registered `MessageConnector` — this plugin registers no
actions or providers of its own.

Node-only (`"runtime": "node"` in package.json). Not compatible with browser or
mobile runtimes.

## Install

```bash
bun add @elizaos/plugin-twitch
```

Add the plugin name to a character's `plugins` array, or rely on auto-enable: a
`twitch` connector block under agent config activates the plugin automatically
unless `enabled: false` is set.

```ts
import type { Character } from "@elizaos/core";

const character: Character = {
  name: "my-agent",
  plugins: ["@elizaos/plugin-twitch"],
};
```

## Prerequisites

1. A Twitch application registered at the
   [Twitch Developer Console](https://dev.twitch.tv/console) (provides the
   client ID, and a client secret if you want token refresh).
2. An OAuth access token with `chat:read` and `chat:edit` scopes.

## Configuration

Settings resolve in priority order: a per-account object in `TWITCH_ACCOUNTS`
JSON > `character.settings.twitch` > top-level env vars (default account only).
See `src/accounts.ts` (`resolveTwitchAccountSettings`).

### Required

| Variable | Description |
|----------|-------------|
| `TWITCH_USERNAME` | Bot's Twitch login name |
| `TWITCH_CLIENT_ID` | Application client ID |
| `TWITCH_ACCESS_TOKEN` | OAuth token (`oauth:` prefix stripped automatically) |
| `TWITCH_CHANNEL` | Primary channel to join (no `#` prefix) |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `TWITCH_CLIENT_SECRET` | Enables `RefreshingAuthProvider`; without it a `StaticAuthProvider` is used | - |
| `TWITCH_REFRESH_TOKEN` | Passed to `RefreshingAuthProvider` when the client secret is also set | - |
| `TWITCH_CHANNELS` | Comma-separated additional channels to join at startup | - |
| `TWITCH_REQUIRE_MENTION` | `"true"` only processes messages that @mention the bot | `false` |
| `TWITCH_ALLOWED_ROLES` | Comma-separated: `all`, `owner`, `moderator`, `vip`, `subscriber` | `all` |
| `TWITCH_ACCOUNTS` | JSON array/object for multi-account mode | - |
| `TWITCH_ACCOUNT_ID` / `TWITCH_DEFAULT_ACCOUNT_ID` | Select the default account when several are configured | - |

The same settings can live under `character.settings.twitch` as camelCase
fields (`username`, `clientId`, `accessToken`, `channel`, `additionalChannels`,
`requireMention`, `allowedRoles`, `allowedUserIds`), with a nested `accounts`
map for multi-account configs.

## Messaging operations

Twitch chat operations route through the canonical `MESSAGE` action with
`source: "twitch"`. The connector exposes these operations:

| Operation | Description |
|-----------|-------------|
| `send` | Send a message to a Twitch channel |
| `join` | Join a Twitch channel |
| `leave` | Leave a Twitch channel (the primary channel cannot be left) |
| `list_channels` | List the configured/joined Twitch channels |

Messages over 500 characters are split at sentence/word boundaries with a 300 ms
delay between chunks (`splitMessageForTwitch`). LLM markdown is converted to
plain text before sending (`stripMarkdownForTwitch`); Twitch does not render
markdown.

## Events

`TwitchService` emits these runtime events (string constants on
`TwitchEventTypes`):

| Constant | String value |
|----------|--------------|
| `MESSAGE_RECEIVED` | `TWITCH_MESSAGE_RECEIVED` |
| `MESSAGE_SENT` | `TWITCH_MESSAGE_SENT` |
| `JOIN_CHANNEL` | `TWITCH_JOIN_CHANNEL` |
| `LEAVE_CHANNEL` | `TWITCH_LEAVE_CHANNEL` |
| `CONNECTION_READY` | `TWITCH_CONNECTION_READY` |
| `CONNECTION_LOST` | `TWITCH_CONNECTION_LOST` |

## Source layout

```
src/
  index.ts                        Plugin entry (default export)
  service.ts                      TwitchService — IRC lifecycle, connector handlers
  accounts.ts                     Multi-account config resolution
  connector-account-provider.ts   ConnectorAccountProvider adapter
  workflow-credential-provider.ts TwitchWorkflowCredentialProvider service
  types.ts                        Interfaces, enums, constants, utils, errors
auto-enable.ts                    Lightweight shouldEnable() for the auto-enable engine
```

## Commands

```bash
bun run --cwd plugins/plugin-twitch build         # compile dist/
bun run --cwd plugins/plugin-twitch test          # bun test
bun run --cwd plugins/plugin-twitch format        # biome format --write
bun run --cwd plugins/plugin-twitch format:check  # biome format (check only)
```

## License

MIT
