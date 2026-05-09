# @elizaos/plugin-line

LINE Messaging API plugin for ElizaOS agents. Enables chatbot integration with LINE, a popular messaging platform in Japan, Taiwan, and Thailand.

## Features

- **Text Messages**: Send and receive text messages
- **Rich Messages (Flex)**: Create visually rich card messages
- **Location Messages**: Share locations with map pins
- **Quick Replies**: Provide suggested reply options
- **Group/Room Support**: Operate in groups and multi-user rooms
- **User Profiles**: Access user display names, pictures, and language
- **Webhook Integration**: Receive messages via LINE webhooks

## Installation

```bash
# npm
npm install @elizaos/plugin-line

# bun
bun add @elizaos/plugin-line
```

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `LINE_CHANNEL_ACCESS_TOKEN` | Channel access token from LINE Developers Console | Yes |
| `LINE_CHANNEL_SECRET` | Channel secret for webhook verification | Yes |
| `LINE_WEBHOOK_PATH` | Webhook endpoint path | No |
| `LINE_DM_POLICY` | DM policy: open, pairing, allowlist, disabled | No |
| `LINE_GROUP_POLICY` | Group policy: open, allowlist, disabled | No |
| `LINE_ALLOW_FROM` | Comma-separated user IDs for allowlist | No |
| `LINE_ENABLED` | Enable/disable the plugin | No |

### Agent Configuration

```json
{
  "plugins": ["@elizaos/plugin-line"],
  "pluginParameters": {
    "LINE_CHANNEL_ACCESS_TOKEN": "your-channel-access-token",
    "LINE_CHANNEL_SECRET": "your-channel-secret",
    "LINE_DM_POLICY": "pairing",
    "LINE_GROUP_POLICY": "allowlist"
  }
}
```

## Setup

1. Create a LINE Developers account at https://developers.line.biz/
2. Create a new Messaging API channel
3. Get your Channel Access Token (issue a long-lived token)
4. Get your Channel Secret
5. Set up webhook URL pointing to your server

## Usage

### Actions

LINE messaging routes through the canonical `MESSAGE` action using
`source: "line"`.

| Primary action | Operation | Description |
|----------------|-----------|-------------|
| `MESSAGE` | `send` | Send text, flex, or location content to a user, group, or room |
| `MESSAGE` | `read_channel` | Read recent LINE conversation history when available |
| `MESSAGE` | `list_channels` | List recent LINE targets when available |

### Providers

LINE does not register standalone planner providers. Chat and user context is
exposed through the LINE message connector hooks.

## LINE ID Formats

- **User IDs**: Start with `U` followed by 32 hex characters (e.g., `U1234567890abcdef1234567890abcdef`)
- **Group IDs**: Start with `C` followed by 32 hex characters
- **Room IDs**: Start with `R` followed by 32 hex characters

## Message Limits

- Text messages: 5000 characters max
- Alt text (for flex/template): 400 characters max
- Location title/address: 100 characters max
- Messages per push: 5 max (batched automatically)

## Webhook Setup

1. Configure your webhook URL in the LINE Developers Console
2. Ensure your server verifies webhook signatures using the channel secret
3. The plugin provides middleware for Express-style webhook handling

```typescript
import { LineService } from "@elizaos/plugin-line";

// Get the middleware
const middleware = lineService.createMiddleware();

// Use with Express
app.post("/webhooks/line", middleware, async (req, res) => {
  const events = req.body.events;
  await lineService.handleWebhookEvents(events);
  res.status(200).end();
});
```

## Flex Messages

LINE Flex Messages allow rich visual content. The plugin supports creating info card bubbles:

```typescript
const flexMessage = {
  altText: "Update Notification",
  contents: {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: "Title", weight: "bold", size: "xl" },
        { type: "text", text: "Body content", margin: "md", wrap: true }
      ]
    }
  }
};
```

## Security Policies

### DM Policies

| Policy | Description |
|--------|-------------|
| `open` | Accept DMs from anyone |
| `pairing` | Accept DMs and remember senders |
| `allowlist` | Only accept from LINE_ALLOW_FROM list |
| `disabled` | Don't accept any DMs |

### Group Policies

| Policy | Description |
|--------|-------------|
| `open` | Respond to anyone in groups |
| `allowlist` | Only respond to allowed users |
| `disabled` | Don't respond in groups |

## Development

### Building

```bash
cd typescript && npm run build
```

### Testing

```bash
npm test
```

## API Reference

### LineService

#### Methods

- `isConnected()`: Check connection status
- `getBotInfo()`: Get bot profile
- `sendMessage(to, text, options?)`: Send text message
- `sendFlexMessage(to, flex)`: Send flex message
- `sendTemplateMessage(to, template)`: Send template message
- `sendLocationMessage(to, location)`: Send location
- `replyMessage(replyToken, messages)`: Reply using token
- `getUserProfile(userId)`: Get user profile
- `getGroupInfo(groupId)`: Get group info
- `leaveChat(chatId, chatType)`: Leave group/room

## License

MIT
