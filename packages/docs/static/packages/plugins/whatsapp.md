# @elizaos/plugin-whatsapp

## Purpose

A plugin for integrating WhatsApp Cloud API with your application, providing comprehensive messaging capabilities and webhook handling.

## Key Features

- Send text messages
- Send template messages
- Webhook verification
- Webhook event handling
- Message status updates

## Installation

```bash
bun install @elizaos/plugin-whatsapp
```

## Configuration

```env
WHATSAPP_ACCESS_TOKEN=your_access_token       # Required: WhatsApp Cloud API access token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id # Required: WhatsApp business phone number ID
WHATSAPP_WEBHOOK_TOKEN=your_webhook_token     # Optional: Webhook verification token
WHATSAPP_BUSINESS_ID=your_business_id        # Optional: Business account ID
```

## Example Usage

```typescript
// Basic setup
import { WhatsAppPlugin } from '@elizaos/plugin-whatsapp';

const whatsappPlugin = new WhatsAppPlugin({
  accessToken: 'your_access_token',
  phoneNumberId: 'your_phone_number_id',
  webhookVerifyToken: 'your_webhook_verify_token',
  businessAccountId: 'your_business_account_id',
});

// Send a text message
await whatsappPlugin.sendMessage({
  type: 'text',
  to: '1234567890',
  content: 'Hello from WhatsApp!',
});

// Verify webhook
app.get('/webhook', (req, res) => {
  const verified = await whatsappPlugin.verifyWebhook(req.query['hub.verify_token']);
  if (verified) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});
```
