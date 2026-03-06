# @elizaos/plugin-twitch

Twitch chat integration plugin for elizaOS agents.

## Features

- **Real-time Chat**: Connect to Twitch channels and participate in chat
- **Multi-channel Support**: Join and monitor multiple channels simultaneously
- **Role-based Access Control**: Filter interactions by user roles (broadcaster, moderator, VIP, subscriber)
- **Mention Detection**: Optionally only respond when @mentioned
- **Token Refresh**: Automatic OAuth token refresh (when configured)
- **Markdown Stripping**: Automatically converts markdown to plain text for Twitch

## Installation

```bash
npm install @elizaos/plugin-twitch
```

## Prerequisites

1. **Twitch Developer Account**: Register your application at [Twitch Developer Console](https://dev.twitch.tv/console)
2. **OAuth Token**: Generate a token with `chat:read` and `chat:edit` scopes at [Twitch Token Generator](https://twitchtokengenerator.com/)

## Configuration

Set the following environment variables:

### Required

| Variable | Description |
|----------|-------------|
| `TWITCH_USERNAME` | Bot's Twitch username |
| `TWITCH_CLIENT_ID` | Application client ID from Twitch Developer Console |
| `TWITCH_ACCESS_TOKEN` | OAuth access token with chat:read and chat:edit scopes |
| `TWITCH_CHANNEL` | Primary channel to join (without # prefix) |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `TWITCH_CLIENT_SECRET` | Application client secret (for token refresh) | - |
| `TWITCH_REFRESH_TOKEN` | OAuth refresh token (for automatic refresh) | - |
| `TWITCH_CHANNELS` | Comma-separated list of additional channels | - |
| `TWITCH_REQUIRE_MENTION` | Only respond when @mentioned | `false` |
| `TWITCH_ALLOWED_ROLES` | Comma-separated roles allowed to interact | `all` |

### Allowed Roles

- `all` - Anyone can interact
- `owner` / `broadcaster` - Channel owner only
- `moderator` - Moderators
- `vip` - VIP users
- `subscriber` - Subscribers

## Usage

### Basic Setup

```typescript
import twitchPlugin from "@elizaos/plugin-twitch";

const agent = new Agent({
  plugins: [twitchPlugin],
});
```

### Actions

#### TWITCH_SEND_MESSAGE

Send a message to a Twitch channel.

```typescript
// User: "Send a message saying 'Hello everyone!'"
// Agent will send to the current channel
```

#### TWITCH_JOIN_CHANNEL

Join a new Twitch channel.

```typescript
// User: "Join the channel xqc"
// Agent will join #xqc
```

#### TWITCH_LEAVE_CHANNEL

Leave a Twitch channel.

```typescript
// User: "Leave the channel xqc"
// Agent will leave #xqc (cannot leave primary channel)
```

#### TWITCH_LIST_CHANNELS

List all channels the bot is currently in.

```typescript
// User: "What channels are you in?"
// Agent will list all joined channels
```

### Providers

#### twitchChannelState

Provides context about the current Twitch channel:
- Channel name
- Whether it's the primary channel
- List of all joined channels
- Bot username

#### twitchUserContext

Provides context about the user in the conversation:
- User ID and username
- Display name
- Roles (broadcaster, moderator, VIP, subscriber)
- Chat color

### Events

The plugin emits the following events:

| Event | Description |
|-------|-------------|
| `TWITCH_MESSAGE_RECEIVED` | A chat message was received |
| `TWITCH_MESSAGE_SENT` | A message was sent |
| `TWITCH_JOIN_CHANNEL` | Bot joined a channel |
| `TWITCH_LEAVE_CHANNEL` | Bot left a channel |
| `TWITCH_CONNECTION_READY` | Connected to Twitch |
| `TWITCH_CONNECTION_LOST` | Connection lost |

## Message Limits

- Maximum message length: 500 characters
- Messages longer than 500 characters are automatically split

## Security Considerations

1. **Token Security**: Never expose your access token in client-side code
2. **Scope Limitation**: Only request necessary OAuth scopes
3. **Role Filtering**: Use `TWITCH_ALLOWED_ROLES` to restrict who can interact
4. **Mention Requirement**: Enable `TWITCH_REQUIRE_MENTION` in busy channels

## Troubleshooting

### Connection Issues

1. Verify your OAuth token is valid and not expired
2. Check that the username matches the token owner
3. Ensure the client ID is correct

### Authentication Errors

1. Regenerate your OAuth token
2. Verify scopes include `chat:read` and `chat:edit`
3. Check for typos in environment variables

### Message Not Sending

1. Verify you have joined the target channel
2. Check that the channel name is correct (no # prefix)
3. Ensure your token has `chat:edit` scope

## Multi-language Support

This plugin supports:
- **TypeScript** - Full implementation with @twurple/chat
- **Python** - Full implementation with twitchio
- **Rust** - Full implementation with native WebSocket

## License

MIT
