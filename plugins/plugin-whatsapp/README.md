# plugin-whatsapp

WhatsApp plugin for ElizaOS. Supports both WhatsApp Cloud API and Baileys (QR authentication), enabling agents to send and receive messages, media, reactions, and interactive content via WhatsApp.

## Features

- **Text Messages**: Send and receive text messages with URL preview
- **Media Messages**: Send images, videos, audio, documents, and stickers
- **Reactions**: Send and remove emoji reactions on messages
- **Interactive Messages**: Send button and list messages for rich interactions
- **Location Messages**: Share location data with name and address
- **Template Messages**: Send pre-approved message templates
- **Webhooks**: Handle incoming messages and status updates
- **Baileys QR Auth**: Connect personal WhatsApp accounts with QR login + session persistence
- **Message Status**: Track sent, delivered, read, and failed statuses
- **Media Downloads**: Retrieve media URLs for incoming messages

## Installation

### TypeScript

```bash
npm install @elizaos/plugin-whatsapp
```
## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WHATSAPP_ACCESS_TOKEN` | Yes | WhatsApp Business API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | Yes | Phone number ID from WhatsApp Business API |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | No | Token for webhook verification |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | No | Business account ID |
| `WHATSAPP_API_VERSION` | No | Graph API version (default: v24.0) |
| `WHATSAPP_AUTH_METHOD` | No | `cloudapi` or `baileys` (auto-detected if omitted) |
| `WHATSAPP_AUTH_DIR` | No | Path for Baileys multi-file auth state |
| `WHATSAPP_SESSION_PATH` | No | Alternative to `WHATSAPP_AUTH_DIR` for Baileys auth state |
| `WHATSAPP_PRINT_QR` | No | Print QR in terminal for Baileys auth (default: true) |
| `WHATSAPP_DM_POLICY` | No | DM handling policy: `open`, `allowlist`, `pairing`, or `disabled` |
| `WHATSAPP_GROUP_POLICY` | No | Group handling policy: `open`, `allowlist`, or `disabled` |
| `WHATSAPP_ALLOW_FROM` | No | Comma-separated allowlist for DM senders (when DM policy is `allowlist`) |
| `WHATSAPP_GROUP_ALLOW_FROM` | No | Comma-separated allowlist for group senders (when group policy is `allowlist`) |

### TypeScript Configuration

The plugin self-registers `WhatsAppConnectorService` on the elizaOS runtime and reads its config from runtime settings / environment variables — no manual construction is required. Just register the default export on your character/agent:

```typescript
import whatsappPlugin from "@elizaos/plugin-whatsapp";

export const character = {
  // ...
  plugins: [whatsappPlugin],
};
```

The service picks up `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` (Cloud API) or `WHATSAPP_AUTH_DIR` (Baileys / QR) automatically. See the env-var table above.

To access the service at runtime (e.g. to send a message from your own code):

```typescript
import type { WhatsAppConnectorService } from "@elizaos/plugin-whatsapp";

const service = runtime.getService<WhatsAppConnectorService>("whatsapp");
await service?.sendMessage({ type: "text", to: "+14155552671", content: "hello" });
```

## Usage

### Sending Messages

The TypeScript snippets below use two variables:

- `service` — the registered `WhatsAppConnectorService`, obtained via `runtime.getService<WhatsAppConnectorService>("whatsapp")`. This is the recommended path: it routes through the same auth + policy stack the agent uses for incoming messages.
- `client` — the underlying low-level client (`IWhatsAppClient`), used only for advanced media APIs not exposed on the service. Construct one with the exported `ClientFactory.create({ accessToken, phoneNumberId })` (Cloud API) or `ClientFactory.create({ authDir })` (Baileys) — the concrete `WhatsAppClient` / `BaileysClient` classes are internal.

#### Text Message

**TypeScript**:
```typescript
const service = runtime.getService<WhatsAppConnectorService>("whatsapp");
await service?.sendMessage({ type: "text", to: "1234567890", content: "Hello, World!" });
```

**Python**:

**Rust**:

#### Image Message

**TypeScript**:
```typescript
await client.sendImage('1234567890', 'https://example.com/image.jpg', 'Caption');
```

**Python**:

**Rust**:

#### Interactive Button Message

**TypeScript**:
```typescript
await client.sendButtonMessage(
    '1234567890',
    'Choose an option:',
    [
        { id: 'opt1', title: 'Option 1' },
        { id: 'opt2', title: 'Option 2' },
        { id: 'opt3', title: 'Option 3' },
    ],
    'Header Text',
    'Footer Text'
);
```

**Python**:

**Rust**:

### Sending Reactions

**TypeScript**:
```typescript
await client.sendReaction({
    to: '1234567890',
    messageId: 'wamid.xxx',
    emoji: '👍',
});

// Remove reaction
await client.removeReaction('1234567890', 'wamid.xxx');
```

**Python**:

**Rust**:

### Handling Webhooks

**TypeScript**:
```typescript
import express from 'express';

const app = express();

const service = runtime.getService<WhatsAppConnectorService>("whatsapp");

// Verification endpoint
app.get('/webhook', (req, res) => {
    const mode = String(req.query['hub.mode'] ?? '');
    const token = String(req.query['hub.verify_token'] ?? '');
    const challenge = String(req.query['hub.challenge'] ?? '');

    const reply = service?.verifyWebhook(mode, token, challenge);
    if (reply) {
        res.status(200).send(reply);
    } else {
        res.sendStatus(403);
    }
});

// Message handling endpoint
app.post('/webhook', express.json(), async (req, res) => {
    await service?.handleWebhook(req.body);
    res.sendStatus(200);
});
```

**Python**:

**Rust**:

### Event Handling

**TypeScript** (using event emitter pattern):
```typescript
// Events are emitted by the webhook handler
webhookHandler.onMessage((message) => {
    console.log('Message received:', message);
});

webhookHandler.onStatus((status) => {
    console.log('Status update:', status);
});
```

**Python**:

**Rust**:

## Actions

WhatsApp messaging is exposed through the canonical message connector actions.
Use `source: "whatsapp"` when a request needs to target WhatsApp explicitly.
Media, templates, and interactive messages remain available through the service
and low-level client APIs shown above; they are not advertised as separate
executable action names.

| Primary action | Operation | Description |
|----------------|-----------|-------------|
| `MESSAGE` | `send` | Send a message to a phone number, contact, user, group, or room |
| `MESSAGE` | `read` | Read recent WhatsApp conversation messages |
| `MESSAGE` | `search` | Search WhatsApp conversation history |
| `MESSAGE` | `react` | Send or remove a reaction on a message |
| `MESSAGE` | `get_user` | Resolve a WhatsApp contact or user |

## Event Types

| Event | Description |
|-------|-------------|
| `MESSAGE_RECEIVED` | New message received |
| `MESSAGE_SENT` | Message was sent |
| `MESSAGE_DELIVERED` | Message was delivered |
| `MESSAGE_READ` | Message was read |
| `MESSAGE_FAILED` | Message delivery failed |
| `REACTION_RECEIVED` | Reaction received on a message |
| `REACTION_SENT` | Reaction was sent |
| `INTERACTIVE_REPLY` | User replied to interactive message |
| `WEBHOOK_VERIFIED` | Webhook was verified |

## Common Reactions

The plugin provides constants for common reaction emojis:

| Name | Emoji |
|------|-------|
| `THUMBS_UP` | 👍 |
| `THUMBS_DOWN` | 👎 |
| `HEART` | ❤️ |
| `LAUGHING` | 😂 |
| `SURPRISED` | 😮 |
| `SAD` | 😢 |
| `PRAYING` | 🙏 |
| `CLAPPING` | 👏 |
| `FIRE` | 🔥 |
| `CELEBRATION` | 🎉 |

## API Reference

### WhatsAppClient / WhatsAppService

| Method | Description |
|--------|-------------|
| `sendTextMessage(to, text)` | Send a text message |
| `sendImage(to, url, caption?)` | Send an image |
| `sendVideo(to, url, caption?)` | Send a video |
| `sendAudio(to, url)` | Send audio |
| `sendDocument(to, url, filename?, caption?)` | Send a document |
| `sendLocation(to, lat, lng, name?, address?)` | Send a location |
| `sendReaction(params)` | Send a reaction |
| `removeReaction(to, messageId)` | Remove a reaction |
| `sendButtonMessage(to, body, buttons, header?, footer?)` | Send button message |
| `sendListMessage(to, body, buttonText, sections, header?, footer?)` | Send list message |
| `markMessageAsRead(messageId)` | Mark a message as read |
| `getMediaUrl(mediaId)` | Get download URL for media |
| `verifyWebhook(token)` | Verify webhook token |

## Troubleshooting

### Common Issues

1. **Message not delivered**: Ensure the phone number is in international format without `+` prefix (e.g., `1234567890`).

2. **Webhook not verified**: Check that your `WHATSAPP_WEBHOOK_VERIFY_TOKEN` matches the token configured in the Meta Developer Portal.

3. **Media upload fails**: Ensure media URLs are publicly accessible and the file format is supported by WhatsApp.

4. **Rate limiting**: WhatsApp has rate limits on the number of messages. Implement exponential backoff for retries.

### Error Codes

| Code | Description |
|------|-------------|
| 130429 | Rate limit reached |
| 131000 | Something went wrong |
| 131030 | Invalid recipient |
| 131051 | Message type is not supported |

## License

MIT
