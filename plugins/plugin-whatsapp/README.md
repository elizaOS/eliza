# plugin-whatsapp

WhatsApp Cloud API plugin for ElizaOS. Provides comprehensive integration with the WhatsApp Business Cloud API, enabling agents to send and receive messages, media, reactions, and interactive content via WhatsApp.

## Features

- **Text Messages**: Send and receive text messages with URL preview
- **Media Messages**: Send images, videos, audio, documents, and stickers
- **Reactions**: Send and remove emoji reactions on messages
- **Interactive Messages**: Send button and list messages for rich interactions
- **Location Messages**: Share location data with name and address
- **Template Messages**: Send pre-approved message templates
- **Webhooks**: Handle incoming messages and status updates
- **Message Status**: Track sent, delivered, read, and failed statuses
- **Media Downloads**: Retrieve media URLs for incoming messages
- **Multi-language Support**: TypeScript, Python, and Rust implementations

## Installation

### TypeScript

```bash
npm install @elizaos/plugin-whatsapp
```

### Python

```bash
pip install elizaos-plugin-whatsapp
```

### Rust

Add to `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-whatsapp = "2.0.0-alpha.1"
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WHATSAPP_ACCESS_TOKEN` | Yes | WhatsApp Business API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | Yes | Phone number ID from WhatsApp Business API |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | No | Token for webhook verification |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | No | Business account ID |
| `WHATSAPP_API_VERSION` | No | Graph API version (default: v18.0) |

### TypeScript Configuration

```typescript
import { WhatsAppPlugin } from '@elizaos/plugin-whatsapp';

const plugin = new WhatsAppPlugin({
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
    webhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    apiVersion: 'v18.0',
});
```

### Python Configuration

```python
from elizaos_plugin_whatsapp import WhatsAppService

# From environment variables
service = WhatsAppService.from_env()

# Or with explicit config
from elizaos_plugin_whatsapp import WhatsAppConfig

config = WhatsAppConfig(
    access_token="your_token",
    phone_number_id="your_phone_id",
    webhook_verify_token="optional_verify_token",
    api_version="v18.0",
)
service = WhatsAppService(config)
```

### Rust Configuration

```rust
use elizaos_plugin_whatsapp::{WhatsAppConfig, WhatsAppService};

// From environment variables
let service = WhatsAppService::from_env()?;

// Or with explicit config
let config = WhatsAppConfig::new(
    "your_access_token".to_string(),
    "your_phone_number_id".to_string(),
)
.with_webhook_verify_token("optional_token".to_string());

let service = WhatsAppService::new(config);
```

## Usage

### Sending Messages

#### Text Message

**TypeScript**:
```typescript
await client.sendTextMessage('1234567890', 'Hello, World!');
```

**Python**:
```python
await service.send_text('1234567890', 'Hello, World!')
```

**Rust**:
```rust
service.send_text("1234567890", "Hello, World!").await?;
```

#### Image Message

**TypeScript**:
```typescript
await client.sendImage('1234567890', 'https://example.com/image.jpg', 'Caption');
```

**Python**:
```python
await service.send_image('1234567890', 'https://example.com/image.jpg', caption='Caption')
```

**Rust**:
```rust
service.send_image("1234567890", "https://example.com/image.jpg", Some("Caption")).await?;
```

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
```python
await service.send_button_message(
    '1234567890',
    'Choose an option:',
    [
        {'id': 'opt1', 'title': 'Option 1'},
        {'id': 'opt2', 'title': 'Option 2'},
        {'id': 'opt3', 'title': 'Option 3'},
    ],
    header_text='Header Text',
    footer_text='Footer Text',
)
```

**Rust**:
```rust
service.send_button_message(
    "1234567890",
    "Choose an option:",
    &[
        ("opt1".to_string(), "Option 1".to_string()),
        ("opt2".to_string(), "Option 2".to_string()),
        ("opt3".to_string(), "Option 3".to_string()),
    ],
    Some("Header Text"),
    Some("Footer Text"),
).await?;
```

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
```python
from elizaos_plugin_whatsapp import SendReactionParams

await service.send_reaction(SendReactionParams(
    to='1234567890',
    message_id='wamid.xxx',
    emoji='👍',
))

# Remove reaction
await service.remove_reaction('1234567890', 'wamid.xxx')
```

**Rust**:
```rust
use elizaos_plugin_whatsapp::SendReactionParams;

service.send_reaction(&SendReactionParams {
    to: "1234567890".to_string(),
    message_id: "wamid.xxx".to_string(),
    emoji: "👍".to_string(),
}).await?;

// Remove reaction
service.remove_reaction("1234567890", "wamid.xxx").await?;
```

### Handling Webhooks

**TypeScript**:
```typescript
import express from 'express';

const app = express();

// Verification endpoint
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    
    if (mode === 'subscribe' && plugin.verifyWebhook(token)) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Message handling endpoint
app.post('/webhook', express.json(), async (req, res) => {
    await plugin.handleWebhook(req.body);
    res.sendStatus(200);
});
```

**Python**:
```python
from aiohttp import web

async def verify_webhook(request):
    mode = request.query.get('hub.mode')
    token = request.query.get('hub.verify_token')
    challenge = request.query.get('hub.challenge')
    
    result = service.verify_webhook(mode, token, challenge)
    if result:
        return web.Response(text=result)
    return web.Response(status=403)

async def handle_webhook(request):
    from elizaos_plugin_whatsapp.types import WhatsAppWebhookEvent
    
    data = await request.json()
    event = WhatsAppWebhookEvent(**data)
    await service.handle_webhook(event)
    return web.Response(status=200)
```

**Rust**:
```rust
// Verification
let challenge = service.verify_webhook(mode, token, challenge_str);

// Handle webhook event
let event: WhatsAppWebhookEvent = serde_json::from_str(&body)?;
service.handle_webhook(event).await;
```

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
```python
from elizaos_plugin_whatsapp import WhatsAppEventType

service.on_event(WhatsAppEventType.MESSAGE_RECEIVED, lambda msg: print(f"Message: {msg}"))
service.on_event(WhatsAppEventType.MESSAGE_SENT, lambda status: print(f"Sent: {status}"))
service.on_event(WhatsAppEventType.MESSAGE_DELIVERED, lambda status: print(f"Delivered: {status}"))
service.on_event(WhatsAppEventType.MESSAGE_READ, lambda status: print(f"Read: {status}"))
```

**Rust**:
```rust
use elizaos_plugin_whatsapp::WhatsAppEventType;

service.on_event(WhatsAppEventType::MessageReceived, |payload| {
    println!("Message received: {:?}", payload);
}).await;

service.on_event(WhatsAppEventType::MessageSent, |payload| {
    println!("Message sent: {:?}", payload);
}).await;
```

## Actions

The plugin provides the following actions for use with ElizaOS agents:

| Action | Description |
|--------|-------------|
| `WHATSAPP_SEND_MESSAGE` | Send a text message |
| `WHATSAPP_SEND_REACTION` | Send a reaction to a message |
| `WHATSAPP_SEND_MEDIA` | Send an image, video, audio, or document |
| `WHATSAPP_SEND_INTERACTIVE` | Send a button or list message |

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
