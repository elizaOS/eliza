# Blooio Plugin for ElizaOS

Integrates Blooio iMessage/SMS messaging into ElizaOS with signed webhooks and outbound message sending.

## Overview

The Blooio plugin enables ElizaOS agents to:

- Send messages to iMessage/SMS chats (phone, email, or group ID)
- Receive inbound messages via Blooio webhooks
- Track recent conversation history per chat
- Verify webhook signatures using the provided signing secret

## Installation

```bash
npm install @elizaos/plugin-blooio
```

## Configuration

### Environment Variables

```env
# Required
BLOOIO_API_KEY=your_blooio_api_key
BLOOIO_WEBHOOK_URL=https://your-domain.com/webhook
BLOOIO_WEBHOOK_SECRET=whsec_...

# Optional
BLOOIO_WEBHOOK_PORT=3001
BLOOIO_WEBHOOK_PATH=/webhook
BLOOIO_BASE_URL=https://backend.blooio.com/v2/api
BLOOIO_FROM_NUMBER=+17147023671
BLOOIO_TEST_CHAT_ID=+15551234567
```

### Character Configuration

```typescript
{
  name: "MyAgent",
  clients: [],
  plugins: ["@elizaos/plugin-blooio"],
  settings: {}
}
```

## Service Architecture

### BlooioService

```typescript
export class BlooioService extends Service {
  async sendMessage(chatId: string, request: BlooioSendMessageRequest): Promise<BlooioSendMessageResponse>;
}
```

### Webhook Server

The plugin starts an Express server and listens on the path derived from `BLOOIO_WEBHOOK_URL`
or `BLOOIO_WEBHOOK_PATH` if provided. The endpoint verifies `X-Blooio-Signature` using
`BLOOIO_WEBHOOK_SECRET`.

## Actions

### Send Message

```typescript
{
  name: "SEND_MESSAGE",
  description: "Send a message via Blooio to a chat (phone, email, or group)"
}
```

## Providers

### Conversation History Provider

```typescript
{
  name: "blooioConversationHistory",
  description: "Provides recent Blooio conversation history with a chat"
}
```

## Testing

Run unit tests:

```bash
npm run test:unit
```

To test outbound sending, set `BLOOIO_TEST_CHAT_ID` and run:

```bash
npm test
```

## Security Notes

- Always verify webhook signatures in production.
- Use HTTPS for webhook URLs.
- Rotate your signing secret if compromised.
