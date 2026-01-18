# @elizaos/plugin-whatsapp

A plugin for integrating WhatsApp Cloud API with your application, providing comprehensive messaging capabilities and webhook handling.

## Overview

This plugin provides functionality to:

- Send text and template messages via WhatsApp
- Handle incoming webhook events
- Manage message status updates
- Process message delivery notifications
- Handle authentication and session management

## Installation

```bash
npm install @elizaos/plugin-whatsapp
```

## Configuration

The plugin requires the following environment variables:

```env
WHATSAPP_ACCESS_TOKEN=your_access_token       # Required: WhatsApp Cloud API access token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id # Required: WhatsApp business phone number ID
WHATSAPP_WEBHOOK_TOKEN=your_webhook_token     # Optional: Webhook verification token
WHATSAPP_BUSINESS_ID=your_business_id        # Optional: Business account ID
```

## Usage

### Basic Setup

```typescript
import { WhatsAppPlugin } from "@elizaos/plugin-whatsapp";

const whatsappPlugin = new WhatsAppPlugin({
    accessToken: "your_access_token",
    phoneNumberId: "your_phone_number_id",
    webhookVerifyToken: "your_webhook_verify_token",
    businessAccountId: "your_business_account_id",
});
```

### Sending Messages

```typescript
// Send a text message
await whatsappPlugin.sendMessage({
    type: "text",
    to: "1234567890",
    content: "Hello from WhatsApp!",
});

// Send a template message
await whatsappPlugin.sendMessage({
    type: "template",
    to: "1234567890",
    content: {
        name: "hello_world",
        language: {
            code: "en",
        },
    },
});
```

### Handling Webhooks

```typescript
// Verify webhook
app.get("/webhook", (req, res) => {
    const verified = await whatsappPlugin.verifyWebhook(
        req.query["hub.verify_token"]
    );
    if (verified) {
        res.send(req.query["hub.challenge"]);
    } else {
        res.sendStatus(403);
    }
});

// Handle webhook events
app.post("/webhook", (req, res) => {
    await whatsappPlugin.handleWebhook(req.body);
    res.sendStatus(200);
});
```

## Features

- Send text messages
- Send template messages
- Webhook verification
- Webhook event handling
- Message status updates

## Error Handling

The plugin throws errors in the following cases:

```typescript
try {
    await whatsappPlugin.sendMessage({
        type: "text",
        to: "1234567890",
        content: "Hello!",
    });
} catch (error) {
    console.error("Failed to send message:", error.message);
}
```

Common error cases:

- Invalid configuration
- Failed message sending
- Webhook verification failure
- Invalid webhook payload

## Best Practices

1. Always validate phone numbers before sending messages
2. Use template messages for first-time messages to users
3. Store message IDs for tracking delivery status
4. Implement proper error handling
5. Set up webhook retry mechanisms
6. Keep your access tokens secure

## API Reference

### Core Interfaces

```typescript
interface WhatsAppConfig {
    accessToken: string;
    phoneNumberId: string;
    webhookVerifyToken?: string;
    businessAccountId?: string;
}

interface WhatsAppMessage {
    type: "text" | "template";
    to: string;
    content: string | WhatsAppTemplate;
}

interface WhatsAppTemplate {
    name: string;
    language: {
        code: string;
    };
    components?: Array<{
        type: string;
        parameters: Array<{
            type: string;
            text?: string;
        }>;
    }>;
}
```

### Plugin Methods

- `sendMessage`: Send WhatsApp messages
- `handleWebhook`: Process incoming webhook events
- `verifyWebhook`: Verify webhook authenticity
- Message and status handlers

## Development

### Building

```bash
npm run build
```

### Testing

```bash
npm run test
```

### Linting

```bash
npm run lint
```

## Security Best Practices

- Store credentials securely using environment variables
- Validate all phone numbers before sending messages
- Use template messages for first-time contacts
- Implement proper error handling
- Keep dependencies updated
- Monitor API usage and rate limits
- Use HTTPS for all API communication

## Contributing

Contributions are welcome! Please see the [CONTRIBUTING.md](CONTRIBUTING.md) file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api): Meta's official WhatsApp Business Platform
- [Axios](https://axios-http.com/): Promise-based HTTP client for API requests
- [Meta for Developers](https://developers.facebook.com/): Meta's developer platform and tools

Special thanks to:

- The Eliza community for their contributions and feedback

For more information about WhatsApp Cloud API and its capabilities, visit:

- [WhatsApp Business Platform Documentation](https://developers.facebook.com/docs/whatsapp/cloud-api/overview)
- [Meta for Developers Blog](https://developers.facebook.com/blog/)
- [WhatsApp Business API GitHub](https://github.com/WhatsApp/WhatsApp-Business-API-Setup-Scripts)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
