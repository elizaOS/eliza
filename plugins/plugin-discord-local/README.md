# @elizaos/plugin-discord-local

Local Discord desktop integration for elizaOS agents, using the Discord RPC socket and macOS UI
automation to read messages and send replies without the Bot API.

## What it does

- Connects to the Discord desktop app running on the same machine over its local IPC socket.
- Subscribes to `MESSAGE_CREATE` events on configured channels and `NOTIFICATION_CREATE`
  notifications, ingesting each message into the Eliza agent's memory.
- Sends replies by opening the target channel with a `discord://` deep-link and typing the
  message via AppleScript (`osascript`).
- Exposes HTTP routes that a setup UI can call to authorize, inspect status, browse guilds and
  channels, and update channel subscriptions.

**Platform:** macOS only. The send path uses `osascript` and `/usr/bin/open`.

## Capabilities

| Capability | Notes |
|---|---|
| Read incoming messages | `MESSAGE_CREATE` RPC subscription on configured channel IDs |
| Read notifications | `NOTIFICATION_CREATE` RPC subscription (`rpc.notifications.read` scope) |
| Send replies | AppleScript UI automation — focuses Discord, navigates to channel, types text |
| Setup API | HTTP routes for authorization and channel management (see below) |
| OAuth token management | Authorization code + refresh token flow, persisted to disk |
| Auto-reconnect | Reconnects on socket close if a valid session exists |

## Required configuration

These must be set in the agent's settings or environment before the plugin will activate.

| Setting | Description |
|---|---|
| `DISCORD_LOCAL_CLIENT_ID` | Discord application client ID (from [Discord Developer Portal](https://discord.com/developers/applications)) |
| `DISCORD_LOCAL_CLIENT_SECRET` | Discord application client secret |

The Discord application must have the **RPC** feature enabled and `http://localhost` listed as a
redirect URI. Required OAuth scopes: `rpc`, `identify`, `rpc.notifications.read`.

## Optional settings

| Setting | Default | Description |
|---|---|---|
| `DISCORD_LOCAL_ENABLED` | `true` | Set to `"false"` to disable without removing credentials |
| `DISCORD_LOCAL_SCOPES` | `rpc,identify,rpc.notifications.read` | Comma-separated OAuth scopes |
| `DISCORD_LOCAL_MESSAGE_CHANNEL_IDS` | _(none)_ | Comma-separated channel IDs to subscribe to `MESSAGE_CREATE` |
| `DISCORD_LOCAL_SEND_DELAY_MS` | `900` | Delay in ms after focusing Discord before typing (min 100) |

## How to enable

Add the plugin to your agent character or runtime configuration:

```ts
import discordLocalPlugin from "@elizaos/plugin-discord-local";

const character = {
  // ...
  plugins: [discordLocalPlugin],
};
```

On first run, no session exists. Call `POST /api/setup/discord/start` to trigger the OAuth
authorization dialog in the Discord desktop app, then subscribe to channels via
`POST /api/discord/subscriptions`.

## Setup API routes

| Method | Path | Description |
|---|---|---|
| GET | `/api/setup/discord/status` | Connection and auth status |
| POST | `/api/setup/discord/start` | Start OAuth authorization (opens Discord dialog) |
| POST | `/api/setup/discord/cancel` | Disconnect and clear session |
| GET | `/api/discord/guilds` | List guilds the logged-in user belongs to |
| GET | `/api/discord/channels?guildId=<id>` | List channels in a guild |
| POST | `/api/discord/subscriptions` | Set active channel subscriptions (`{ channelIds: string[] }`) |

## How messages flow

1. The `discord-local` service connects to the Discord IPC socket on startup (if a session
   exists) and subscribes to configured channels.
2. Inbound `MESSAGE_CREATE` / `NOTIFICATION_CREATE` payloads are decoded and written to the
   agent's `messages` memory table via `runtime.createMemory`.
3. The agent processes the memory and produces a reply through the normal elizaOS pipeline.
4. The reply is delivered via the `discord-local` send handler registered on
   `runtime.registerSendHandler`. The handler calls `sendUiMessage`, which drives Discord via
   AppleScript.

## Session storage

OAuth tokens are persisted at `<stateDir>/discord-local/session.json`. `stateDir` is resolved by
`resolveStateDir()` from `@elizaos/core` (defaults to `~/.eliza`).

## Limitations

- macOS only — the send path is AppleScript; no Linux/Windows support.
- Authorization requires the Discord desktop app to be open and the user to accept the
  permission dialog interactively. It cannot be automated headlessly.
- Only text messages are sent; attachments and embeds are read but replies are text-only.
- There is no built-in rate limiting on outbound messages beyond the configurable send delay.
