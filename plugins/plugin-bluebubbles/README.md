# @elizaos/plugin-bluebubbles

BlueBubbles iMessage bridge plugin for elizaOS agents. Enables rich iMessage integration through the BlueBubbles macOS app and REST API.

## Features

- **Text Messages**: Send and receive iMessage/SMS messages
- **Reactions**: Add tapback reactions (❤️, 👍, 👎, 😂, ‼️, ❓)
- **Effects**: Send messages with effects (slam, balloons, confetti, etc.)
- **Replies**: Reply to specific messages
- **Edit/Unsend**: Edit or unsend messages (requires Private API)
- **Group Management**: Rename groups, add/remove participants
- **Attachments**: Send images, videos, and files
- **Webhooks**: Real-time message delivery
- **Multi-language Support**: Available in TypeScript, Python, and Rust

## Requirements

- **macOS**: BlueBubbles server runs on macOS
- **BlueBubbles App**: Install from https://bluebubbles.app
- **Private API** (optional): Enable for advanced features like reactions, effects, and editing

## Installation

```bash
# npm
npm install @elizaos/plugin-bluebubbles

# pnpm
pnpm add @elizaos/plugin-bluebubbles
```

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `BLUEBUBBLES_SERVER_URL` | BlueBubbles server URL (e.g., http://192.168.1.100:1234) | Yes |
| `BLUEBUBBLES_PASSWORD` | Server password | Yes |
| `BLUEBUBBLES_WEBHOOK_PATH` | Webhook endpoint path | No |
| `BLUEBUBBLES_DM_POLICY` | DM policy: open, pairing, allowlist, disabled | No |
| `BLUEBUBBLES_GROUP_POLICY` | Group policy: open, allowlist, disabled | No |
| `BLUEBUBBLES_ALLOW_FROM` | Comma-separated handles for allowlist | No |
| `BLUEBUBBLES_SEND_READ_RECEIPTS` | Send read receipts | No |
| `BLUEBUBBLES_ENABLED` | Enable/disable the plugin | No |

### Agent Configuration

```json
{
  "plugins": ["@elizaos/plugin-bluebubbles"],
  "pluginParameters": {
    "BLUEBUBBLES_SERVER_URL": "http://192.168.1.100:1234",
    "BLUEBUBBLES_PASSWORD": "your-password",
    "BLUEBUBBLES_DM_POLICY": "pairing"
  }
}
```

## Setup

1. Install BlueBubbles on your Mac from https://bluebubbles.app
2. Set up the server and note your server URL and password
3. Configure webhook URL in BlueBubbles pointing to your elizaOS instance
4. Optionally enable Private API for advanced features

## Usage

### Actions

#### BLUEBUBBLES_SEND_MESSAGE

Send a text message with optional effects.

```
"Send them 'Hello!'"
"Send +1234567890 'Happy birthday!' with balloons"
"Reply to that message saying 'Thanks!'"
```

#### BLUEBUBBLES_SEND_REACTION

Add or remove reactions on messages.

```
"React to that with a heart"
"Like their message"
"Remove my reaction"
```

### Providers

#### bluebubblesChatContext

Provides information about the current chat:
- Chat GUID
- Handle (phone/email)
- Display name
- Chat type (direct/group)
- Capabilities (reactions, effects, etc.)

## Message Effects

Send messages with visual effects:

| Effect | Description |
|--------|-------------|
| `slam` | Slam effect |
| `loud` | Loud (shake) effect |
| `gentle` | Gentle (fade in) effect |
| `invisible` | Invisible ink |
| `balloons` | Floating balloons |
| `confetti` | Confetti celebration |
| `love` / `hearts` | Heart animation |
| `lasers` | Laser show |
| `fireworks` | Fireworks |
| `celebration` | Sparkles |
| `echo` | Echo effect |
| `spotlight` | Spotlight |

## API Reference

### BlueBubblesService

#### Methods

- `isConnected()`: Check connection status
- `probe(timeoutMs?)`: Probe server health
- `sendMessage(to, text, options?)`: Send a message
- `sendReaction(chatGuid, messageGuid, emoji, remove?)`: Add/remove reaction
- `getChats(limit?, offset?)`: Get chats
- `getChatMessages(chatGuid, limit?)`: Get messages for a chat

### Target Formats

- **Phone numbers**: `+15551234567`, `555-123-4567`
- **Email**: `user@example.com`
- **Chat GUID**: `chat_guid:iMessage;-;+15551234567`
- **Chat ID**: `chat_id:123`
- **Chat Identifier**: `chat_identifier:+15551234567`

## Development

### Building

```bash
# TypeScript
cd typescript && npm run build

# Python
cd python && pip install -e .

# Rust
cd rust && cargo build
```

### Testing

```bash
# TypeScript
npm test

# Python
pytest

# Rust
cargo test
```

## Troubleshooting

### Cannot connect to server

1. Verify the server URL is correct and accessible
2. Check that BlueBubbles is running on your Mac
3. Ensure firewall allows the connection

### Reactions/effects not working

1. Enable Private API in BlueBubbles settings
2. Disable SIP if required (for some features)
3. Check BlueBubbles logs for errors

### Messages not delivering

1. Verify the phone number/email is valid
2. Check if iMessage is signed in on your Mac
3. Try sending via SMS service if iMessage fails

## License

MIT
