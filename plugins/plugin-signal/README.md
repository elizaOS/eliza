# @elizaos/plugin-signal

Signal messaging integration plugin for elizaOS agents with end-to-end encryption support.

## Features

- **Secure Messaging**: End-to-end encrypted communication via Signal protocol
- **Direct Messages**: Send and receive direct messages with contacts
- **Group Chats**: Participate in Signal group conversations
- **Reactions**: Add emoji reactions to messages
- **Contacts**: List and manage Signal contacts
- **Groups**: List and interact with Signal groups
- **Typing Indicators**: Send typing status notifications

## Installation

```bash
npm install @elizaos/plugin-signal
# or
bun add @elizaos/plugin-signal
```

## Prerequisites

This plugin requires a running Signal CLI REST API server or direct access to signal-cli.

### Option 1: Signal CLI REST API (Recommended)

Run the Signal CLI REST API server using Docker:

```bash
docker run -d --name signal-api -p 8080:8080 \
  -v signal-cli-config:/home/.local/share/signal-cli \
  bbernhard/signal-cli-rest-api
```

Then register or link your Signal account:

```bash
# Register a new number
curl -X POST "http://localhost:8080/v1/register/+1234567890"

# Or link to existing Signal account
curl -X GET "http://localhost:8080/v1/qrcodelink?device_name=elizaOS"
```

### Option 2: Signal CLI Direct

Install signal-cli:

```bash
# macOS
brew install signal-cli

# Linux
wget https://github.com/AsamK/signal-cli/releases/latest/download/signal-cli-X.X.X.tar.gz
tar xf signal-cli-*.tar.gz -C /opt
```

Register your phone number with Signal.

## Configuration

### Required Environment Variables

```env
# Your Signal phone number in E.164 format
SIGNAL_ACCOUNT_NUMBER=+1234567890
```

### Optional Environment Variables

```env
# Signal CLI REST API URL (if using HTTP API)
SIGNAL_HTTP_URL=http://localhost:8080

# Path to signal-cli executable (if using CLI directly)
SIGNAL_CLI_PATH=/usr/local/bin/signal-cli

# Ignore group messages (only respond to DMs)
SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES=false
```

## Usage

### Add to your agent configuration

```typescript
import signalPlugin from "@elizaos/plugin-signal";

const agent = {
  // ... other configuration
  plugins: [signalPlugin],
};
```

### Character file configuration

```json
{
  "name": "MyAgent",
  "clients": ["signal"],
  "settings": {
    "signal": {
      "shouldIgnoreGroupMessages": false
    }
  }
}
```

## Actions

| Action | Description |
|--------|-------------|
| `SIGNAL_SEND_MESSAGE` | Send a message to a contact or group |
| `SIGNAL_SEND_REACTION` | React to a message with an emoji |
| `SIGNAL_LIST_CONTACTS` | List Signal contacts |
| `SIGNAL_LIST_GROUPS` | List Signal groups |

## Providers

| Provider | Description |
|----------|-------------|
| `signalConversationState` | Current conversation context and metadata |

## Events

The plugin emits the following events:

- `SIGNAL_MESSAGE_RECEIVED` - When a message is received
- `SIGNAL_MESSAGE_SENT` - When a message is sent
- `SIGNAL_REACTION_RECEIVED` - When a reaction is received
- `SIGNAL_GROUP_JOINED` - When joining a group
- `SIGNAL_GROUP_LEFT` - When leaving a group

## API Reference

### SignalService

The main service class providing direct access to Signal functionality:

```typescript
import { SignalService, SIGNAL_SERVICE_NAME } from "@elizaos/plugin-signal";

// Get service from runtime
const signalService = runtime.getService(SIGNAL_SERVICE_NAME) as SignalService;

// Send a message
await signalService.sendMessage("+1234567890", "Hello!");

// Send a group message
await signalService.sendGroupMessage(groupId, "Hello everyone!");

// Add a reaction
await signalService.sendReaction(
  "+1234567890",
  "👍",
  messageTimestamp,
  authorNumber
);

// Get contacts
const contacts = await signalService.getContacts();

// Get groups
const groups = await signalService.getGroups();
```

## Security Considerations

- Signal provides end-to-end encryption for all messages
- Your Signal account credentials are stored locally
- The HTTP API should only be accessible from trusted networks
- Consider using HTTPS and authentication for production deployments

## Troubleshooting

### Bot not receiving messages

1. Verify Signal CLI REST API is running and accessible
2. Check that your account number is correctly formatted (E.164)
3. Ensure the account is properly registered/linked with Signal

### Messages not sending

1. Verify the recipient number is in E.164 format
2. Check that you have an active internet connection
3. Ensure Signal servers are reachable

### Registration issues

1. Use a phone number that can receive SMS
2. Wait for the verification code
3. Complete the verification process before starting the bot

## License

MIT
