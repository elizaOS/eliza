# Google Chat Plugin for ElizaOS

Google Chat messaging integration for ElizaOS agents, providing full support for Google Workspace team communication.

## Features

- **Messaging**: Send and receive messages in Google Chat spaces
- **Direct Messages**: Support for 1:1 DM conversations
- **Spaces**: Manage presence in Google Chat spaces
- **Threads**: Reply in threaded conversations
- **Reactions**: Add and remove emoji reactions
- **Attachments**: Upload and download media files
- **Webhook Support**: Receive messages via configurable webhook endpoint

## Installation

### TypeScript/JavaScript

```bash
npm install @elizaos-plugins/plugin-google-chat
```
## Prerequisites

1. **Google Cloud Project**: Create a project in the [Google Cloud Console](https://console.cloud.google.com/)

2. **Enable Google Chat API**: 
   - Go to APIs & Services > Library
   - Search for "Google Chat API" and enable it

3. **Create a Chat App**:
   - Go to APIs & Services > Chat API > Configuration
   - Configure your Chat app with a webhook URL

4. **Service Account**:
   - Go to IAM & Admin > Service Accounts
   - Create a service account with Chat API access
   - Download the JSON key file

5. **Configure the Chat App**:
   - Set the App URL (webhook endpoint)
   - Configure the audience type and value

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GOOGLE_CHAT_SERVICE_ACCOUNT` | Service account JSON string | One of these |
| `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE` | Path to service account JSON file | required |
| `GOOGLE_APPLICATION_CREDENTIALS` | Default credentials path | |
| `GOOGLE_CHAT_AUDIENCE_TYPE` | Audience type: `app-url` or `project-number` | Yes |
| `GOOGLE_CHAT_AUDIENCE` | Audience value for token verification | Yes |
| `GOOGLE_CHAT_WEBHOOK_PATH` | Webhook path (default: `/googlechat`) | No |
| `GOOGLE_CHAT_SPACES` | Comma-separated list of spaces | No |
| `GOOGLE_CHAT_REQUIRE_MENTION` | Require @mention in spaces (default: `true`) | No |
| `GOOGLE_CHAT_BOT_USER` | Bot user resource name | No |
| `GOOGLE_CHAT_ENABLED` | Enable/disable plugin (default: `true`) | No |

### Audience Configuration

**App URL (Recommended)**:
- Set `GOOGLE_CHAT_AUDIENCE_TYPE=app-url`
- Set `GOOGLE_CHAT_AUDIENCE` to your Chat app's App URL from the Cloud Console

**Project Number**:
- Set `GOOGLE_CHAT_AUDIENCE_TYPE=project-number`
- Set `GOOGLE_CHAT_AUDIENCE` to your Google Cloud project number

## Usage

### TypeScript

```typescript
import googleChatPlugin from "@elizaos-plugins/plugin-google-chat";

const agent = createAgent({
  plugins: [googleChatPlugin],
  // ... other config
});
```
# Register with ElizaOS runtime
```
## Actions

Google Chat messaging routes through the canonical `MESSAGE` action using
`source: "google-chat"`.

| Primary action | Operation | Description |
|----------------|-----------|-------------|
| `MESSAGE` | `send` | Send or thread a message in a Google Chat space |
| `MESSAGE` | `react` | Add or remove a reaction when the connector supports it |
| `MESSAGE` | `list_channels` | List spaces the bot is a member of |

## Providers

Google Chat does not register standalone planner providers. Space and user
context is exposed through the Google Chat message connector hooks.

## Events

| Event | Description |
|-------|-------------|
| `GOOGLE_CHAT_MESSAGE_RECEIVED` | Message received from a space |
| `GOOGLE_CHAT_MESSAGE_SENT` | Message sent successfully |
| `GOOGLE_CHAT_SPACE_JOINED` | Bot added to a space |
| `GOOGLE_CHAT_SPACE_LEFT` | Bot removed from a space |
| `GOOGLE_CHAT_REACTION_SENT` | Reaction added successfully |
| `GOOGLE_CHAT_CONNECTION_READY` | Service connected and ready |

## Message Limits

- **Maximum message length**: 4,000 characters
- **Attachments**: 20 MB per file (configurable)
- Messages exceeding the limit are automatically chunked

## Webhook Security

The plugin verifies incoming webhook requests using Google's authentication:

1. **App URL mode**: Verifies ID token against the configured app URL
2. **Project Number mode**: Verifies JWT with Google's public certificates

Requests that fail verification are rejected with 401 Unauthorized.

## Resource Names

Google Chat uses resource names for identifying entities:

- **Spaces**: `spaces/{space_id}`
- **Messages**: `spaces/{space_id}/messages/{message_id}`
- **Users**: `users/{user_id}` or `users/app` for the bot
- **Threads**: `spaces/{space_id}/threads/{thread_id}`
- **Reactions**: `spaces/{space_id}/messages/{message_id}/reactions/{reaction_id}`

## Troubleshooting

### Authentication Issues

1. Verify service account JSON is valid
2. Check that the Chat API is enabled
3. Ensure the service account has Chat API permissions
4. Verify audience type and value match your Chat app configuration

### Webhook Not Receiving Messages

1. Verify your webhook URL is accessible from the internet
2. Check that the webhook path matches your configuration
3. Ensure your server responds with 200 OK to POST requests
4. Verify the Chat app is properly configured in Cloud Console

### Permission Denied

1. Check service account permissions
2. Verify the bot is added to the target space
3. Ensure proper IAM roles are assigned

## License

MIT License - see [LICENSE](LICENSE) for details.
