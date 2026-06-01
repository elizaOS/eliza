# @elizaos/plugin-matrix

Matrix messaging integration plugin for elizaOS agents.

## Features

- Connect to any Matrix homeserver via `matrix-js-sdk`
- Receive and send messages in Matrix rooms
- Room membership: join, leave, auto-join on invite
- Reactions, threading, typing indicators, read receipts
- Optional E2EE support
- Multi-account configuration

## Configuration

Set the following environment variables:

### Required

| Variable | Description |
|----------|-------------|
| `MATRIX_HOMESERVER` | Homeserver URL (e.g., https://matrix.org) |
| `MATRIX_USER_ID` | Full Matrix user ID (@user:homeserver.org) |
| `MATRIX_ACCESS_TOKEN` | Access token for authentication |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `MATRIX_DEVICE_ID` | Auto-generated | Device ID for this session |
| `MATRIX_ROOMS` | — | Comma-separated room IDs/aliases to auto-join |
| `MATRIX_AUTO_JOIN` | `false` | Auto-accept room invites |
| `MATRIX_ENCRYPTION` | `false` | Enable E2EE support |
| `MATRIX_REQUIRE_MENTION` | `false` | Only respond when mentioned in rooms |
| `MATRIX_ACCOUNTS` | — | JSON array/object of per-account configs for multi-account setups |
| `MATRIX_DEFAULT_ACCOUNT_ID` | — | Which account is the default when multiple are configured |
| `MATRIX_ACCOUNT_ID` | — | Alias for `MATRIX_DEFAULT_ACCOUNT_ID` |

## Usage

```typescript
import matrixPlugin from "@elizaos/plugin-matrix";
// Pass to the plugin list when constructing an AgentRuntime or character config.
```

## Connector actions

Matrix messaging is exposed through the canonical message connector. Use `source: "matrix"` when a request needs to target Matrix explicitly.

| Operation | Description |
|-----------|-------------|
| `send` | Send a message to a Matrix room, channel, thread, or DM |
| `react` | React to a Matrix message with an emoji |
| `list_channels` | List joined Matrix rooms |
| `join` | Join a Matrix room by ID or alias |
| `leave` | Leave a Matrix room |

There are no registered `Provider` objects. Room context is surfaced through the connector's `getChatContext` and `listRooms` hooks.

## Events

The service emits these events via `runtime.emitEvent`:

| Event | Trigger |
|-------|---------|
| `MATRIX_MESSAGE_RECEIVED` | Incoming `m.room.message` (text only; filtered by `requireMention` if set) |
| `MATRIX_MESSAGE_SENT` | Message sent via `sendMessage` |
| `MATRIX_ROOM_JOINED` | `joinRoom` succeeds |
| `MATRIX_ROOM_LEFT` | `leaveRoom` succeeds |
| `MATRIX_SYNC_COMPLETE` | Matrix `PREPARED` sync state |

Additional constants (`MATRIX_INVITE_RECEIVED`, `MATRIX_REACTION_RECEIVED`, `MATRIX_TYPING_RECEIVED`, `MATRIX_CONNECTION_READY`, `MATRIX_CONNECTION_LOST`) are defined in `MatrixEventTypes` but not currently emitted by the service.

## Message limits

Maximum message length: `MAX_MATRIX_MESSAGE_LENGTH = 4000` characters (exported from `src/types.ts`). The service does not auto-split; callers must chunk before calling `sendMessage`.

## Matrix ID formats

- **User ID**: `@localpart:homeserver.org`
- **Room ID**: `!opaque_id:homeserver.org`
- **Room Alias**: `#human_readable:homeserver.org`
