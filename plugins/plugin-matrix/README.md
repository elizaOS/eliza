# @elizaos/plugin-matrix

Matrix messaging integration plugin for ElizaOS agents.

## Features

- **Decentralized Messaging**: Connect to any Matrix homeserver
- **End-to-End Encryption**: Optional E2EE support for secure communications
- **Room Support**: Join, leave, and manage Matrix rooms
- **Reactions**: React to messages with emoji
- **Threading**: Support for Matrix threads
- **Direct Messages**: Handle DMs and group rooms
- **Typing Indicators**: Send typing notifications
- **Read Receipts**: Mark messages as read

## Installation

```bash
npm install @elizaos/plugin-matrix
```

## Prerequisites

1. **Matrix Account**: A Matrix account on any homeserver
2. **Access Token**: Generate an access token for your account

### Getting an Access Token

You can get an access token by:

1. **Element/Web Client**: Settings -> Help & About -> Access Token
2. **API Login**: Use the Matrix login API with your password
3. **Command Line**: Use `curl` or a tool like `matrix-commander`

## Configuration

Set the following environment variables:

### Required

| Variable | Description |
|----------|-------------|
| `MATRIX_HOMESERVER` | Homeserver URL (e.g., https://matrix.org) |
| `MATRIX_USER_ID` | Full Matrix user ID (@user:homeserver.org) |
| `MATRIX_ACCESS_TOKEN` | Access token for authentication |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `MATRIX_DEVICE_ID` | Device ID for this session | Auto-generated |
| `MATRIX_ROOMS` | Comma-separated room IDs/aliases to auto-join | - |
| `MATRIX_AUTO_JOIN` | Auto-accept room invites | `false` |
| `MATRIX_ENCRYPTION` | Enable E2EE support | `false` |
| `MATRIX_REQUIRE_MENTION` | Only respond when mentioned in rooms | `false` |

## Usage

### Basic Setup

```typescript
import matrixPlugin from "@elizaos/plugin-matrix";

const agent = new Agent({
  plugins: [matrixPlugin],
});
```

### Actions

Matrix messaging is exposed through the canonical message connector actions.
Use `source: "matrix"` when a request needs to target Matrix explicitly.

| Primary action | Operation | Description |
|----------------|-----------|-------------|
| `MESSAGE` | `send` | Send a message to a Matrix room, channel, thread, or DM |
| `MESSAGE` | `react` | React to a Matrix message with an emoji |
| `MESSAGE` | `list_channels` | List joined Matrix rooms |
| `MESSAGE` | `join` | Join a Matrix room by ID or alias |
| `MESSAGE` | `leave` | Leave a Matrix room |

### Providers

#### matrixRoomState

Provides context about the current Matrix room:
- Room ID and name
- Member count
- Encryption status
- Whether it's a DM

#### matrixUserContext

Provides context about the user in the conversation:
- User ID
- Display name
- Avatar URL

### Events

The plugin emits the following events:

| Event | Description |
|-------|-------------|
| `MATRIX_MESSAGE_RECEIVED` | A message was received |
| `MATRIX_MESSAGE_SENT` | A message was sent |
| `MATRIX_ROOM_JOINED` | Joined a room |
| `MATRIX_ROOM_LEFT` | Left a room |
| `MATRIX_INVITE_RECEIVED` | Received a room invite |
| `MATRIX_REACTION_RECEIVED` | Received a reaction |
| `MATRIX_SYNC_COMPLETE` | Initial sync completed |
| `MATRIX_CONNECTION_READY` | Client connected |
| `MATRIX_CONNECTION_LOST` | Connection lost |

## Message Limits

- Maximum message length: 4000 characters
- Longer messages are split automatically

## Matrix ID Formats

- **User ID**: `@localpart:homeserver.org`
- **Room ID**: `!opaque_id:homeserver.org`
- **Room Alias**: `#human_readable:homeserver.org`

## Security Considerations

1. **Token Security**: Never expose your access token
2. **Homeserver Trust**: Only connect to trusted homeservers
3. **E2EE**: Enable encryption for sensitive communications
4. **Room Verification**: Verify room members when using E2EE

## Troubleshooting

### Connection Issues

1. Verify your homeserver URL is correct
2. Check that your access token is valid
3. Ensure your homeserver is reachable

### Sync Issues

1. The initial sync may take time for accounts with many rooms
2. Check homeserver rate limits
3. Verify network connectivity

### Encryption Issues

1. Ensure E2EE is enabled on both ends
2. Verify device is properly set up
3. Check for key verification requirements

## License

MIT
