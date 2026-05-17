# @elizaos/plugin-slack

Slack integration plugin for ElizaOS agents with Socket Mode support.

## Features

- **Socket Mode**: Real-time event handling via Slack Socket Mode
- **Message Operations**: Send, edit, delete, read messages
- **Reactions**: Add and remove emoji reactions
- **Pins**: Pin and unpin messages, list pinned items
- **Channels**: List channels, read channel history
- **User Info**: Get user profile information
- **Threads**: Full thread support with reply tracking
- **Media**: Handle file uploads and attachments
- **Custom Emoji**: List workspace custom emoji

## Installation

```bash
npm install @elizaos/plugin-slack
# or
bun add @elizaos/plugin-slack
```

## Configuration

### Required Environment Variables

```env
# Bot Token (starts with xoxb-)
SLACK_BOT_TOKEN=xoxb-your-bot-token

# App Token for Socket Mode (starts with xapp-)
SLACK_APP_TOKEN=xapp-your-app-token
```

### Optional Environment Variables

```env
# Signing Secret for request verification
SLACK_SIGNING_SECRET=your-signing-secret

# User Token for enhanced permissions (starts with xoxp-)
SLACK_USER_TOKEN=xoxp-your-user-token

# Comma-separated list of channel IDs to restrict bot to
SLACK_CHANNEL_IDS=C123456789,C987654321

# Ignore messages from other bots
SLACK_SHOULD_IGNORE_BOT_MESSAGES=false

# Only respond when mentioned
SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS=false
```

## Slack App Setup

1. Create a new Slack App at https://api.slack.com/apps
2. Enable Socket Mode in your app settings
3. Generate an App-Level Token with `connections:write` scope
4. Add the following Bot Token Scopes:
   - `channels:history` - Read messages in public channels
   - `channels:read` - View basic channel information
   - `chat:write` - Send messages
   - `emoji:read` - View custom emoji
   - `files:read` - View files
   - `groups:history` - Read messages in private channels
   - `groups:read` - View basic private channel information
   - `im:history` - Read direct messages
   - `im:read` - View basic direct message information
   - `mpim:history` - Read group direct messages
   - `mpim:read` - View basic group direct message information
   - `pins:read` - View pinned items
   - `pins:write` - Add and remove pinned items
   - `reactions:read` - View reactions
   - `reactions:write` - Add and remove reactions
   - `team:read` - View workspace information
   - `users:read` - View basic user information
   - `users:read.email` - View user email addresses

5. Enable Events and subscribe to:
   - `message.channels` - Messages in public channels
   - `message.groups` - Messages in private channels
   - `message.im` - Direct messages
   - `message.mpim` - Group direct messages
   - `app_mention` - When the app is mentioned
   - `member_joined_channel` - When a user joins a channel
   - `member_left_channel` - When a user leaves a channel
   - `reaction_added` - When a reaction is added
   - `reaction_removed` - When a reaction is removed

6. Install the app to your workspace

## Usage

### Add to your agent configuration

```typescript
import slackPlugin from "@elizaos/plugin-slack";

const agent = {
  // ... other configuration
  plugins: [slackPlugin],
};
```

### Character file configuration

```json
{
  "name": "MyAgent",
  "clients": ["slack"],
  "settings": {
    "slack": {
      "shouldIgnoreBotMessages": true,
      "shouldRespondOnlyToMentions": false
    }
  }
}
```

## Actions

Slack messaging is exposed through the canonical message connector actions. Use
`source: "slack"` when a request needs to target Slack explicitly.

| Primary action | Operation | Description |
|----------------|-----------|-------------|
| `MESSAGE` | `send` | Send a message to a channel, DM, or thread |
| `MESSAGE` | `read` | Read recent message history from a channel, DM, or thread |
| `MESSAGE` | `search` | Search Slack message history |
| `MESSAGE` | `list_channels` | List available channels |
| `MESSAGE` | `list_servers` | List connected Slack workspaces |
| `MESSAGE` | `react` | Add or remove emoji reactions |
| `MESSAGE` | `edit` | Edit an existing message |
| `MESSAGE` | `delete` | Delete a message |
| `MESSAGE` | `pin` | Pin or unpin a message |
| `MESSAGE` | `get_user` | Get information about a user |

## Providers

| Provider | Description |
|----------|-------------|
| `slackChannelState` | Current channel context and metadata |
| `slackWorkspaceInfo` | Workspace-level information |
| `slackMemberList` | Members in the current channel |

## Events

The plugin emits the following events:

- `SLACK_MESSAGE_RECEIVED` - When a message is received
- `SLACK_MESSAGE_SENT` - When a message is sent
- `SLACK_REACTION_ADDED` - When a reaction is added
- `SLACK_REACTION_REMOVED` - When a reaction is removed
- `SLACK_APP_MENTION` - When the bot is mentioned
- `SLACK_MEMBER_JOINED_CHANNEL` - When a member joins a channel
- `SLACK_MEMBER_LEFT_CHANNEL` - When a member leaves a channel
- `SLACK_FILE_SHARED` - When a file is shared

## API Reference

### SlackService

The main service class providing direct access to Slack functionality:

```typescript
import { SlackService, SLACK_SERVICE_NAME } from "@elizaos/plugin-slack";

// Get service from runtime
const slackService = runtime.getService(SLACK_SERVICE_NAME) as SlackService;

// Send a message
await slackService.sendMessage(channelId, "Hello!", { threadTs: "..." });

// Add a reaction
await slackService.sendReaction(channelId, messageTs, "thumbsup");

// Get user info
const user = await slackService.getUser(userId);

// List channels
const channels = await slackService.listChannels();
```

## Troubleshooting

### Bot not responding to messages

1. Verify your `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are correct
2. Check that Socket Mode is enabled in your Slack app
3. Ensure the bot has been invited to the channel
4. Check if `SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS` is enabled

### Permission errors

1. Verify the bot has all required OAuth scopes
2. Reinstall the app to your workspace after adding new scopes
3. Check if the channel is private and the bot is a member

### Socket Mode connection issues

1. Verify your `SLACK_APP_TOKEN` starts with `xapp-`
2. Check that the app-level token has `connections:write` scope
3. Ensure only one instance of the bot is running per token

## License

MIT
