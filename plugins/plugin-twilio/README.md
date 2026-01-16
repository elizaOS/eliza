# Twilio Plugin for ElizaOS

A comprehensive Twilio integration plugin for ElizaOS that provides bidirectional voice and SMS/MMS messaging capabilities.

## Overview

The Twilio plugin enables ElizaOS agents to interact with users through:

- SMS text messaging (sending and receiving)
- MMS multimedia messaging with attachments
- Voice calls with real-time audio streaming
- Webhook integration for incoming messages and calls
- Conversation history tracking
- Phone number validation and formatting

## Installation

```bash
npm install @elizaos/plugin-twilio
```

## Configuration

### Environment Variables

```env
# Required
TWILIO_ACCOUNT_SID=your_account_sid_here
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_PHONE_NUMBER=+18885551234  # Your Twilio phone number in E.164 format
TWILIO_WEBHOOK_URL=https://your-domain.com/webhooks/twilio  # Public URL for webhooks

# Optional
TWILIO_WEBHOOK_PORT=3000  # Port for webhook server (default: 3000)
TWILIO_TEST_PHONE_NUMBER=+15555551234  # Phone number for testing
```

### Character Configuration

```typescript
{
  name: "MyAgent",
  clients: [],
  plugins: ["@elizaos/plugin-twilio"],
  settings: {
    // Plugin will use runtime.getSetting() to access the above env vars
  }
}
```

## Service Architecture

### TwilioService

The main service class that implements the Twilio integration:

```typescript
export class TwilioService extends Service implements TwilioServiceInterface {
  // Core Twilio functionality
  client: TwilioClient;
  
  // Webhook server for receiving messages/calls
  private app: Express;
  private wss: WebSocketServer;
  
  // Caching for conversation context
  private cache: NodeCache;
  
  // Voice stream management
  private voiceStreams: Map<string, TwilioVoiceStream>;
  
  // Public methods
  async sendSms(to: string, body: string, mediaUrl?: string[]): Promise<TwilioMessage>;
  async makeCall(to: string, twiml?: string, url?: string): Promise<TwilioCall>;
}
```

### Webhook Server

The plugin automatically sets up an Express server to receive Twilio webhooks:

- `/webhooks/twilio/sms` - Receives incoming SMS/MMS messages
- `/webhooks/twilio/voice` - Receives incoming voice calls
- `/webhooks/twilio/status` - Receives status updates for messages and calls

### Voice Streaming

Voice calls are handled via WebSocket connections for real-time audio streaming:

- Supports μ-law audio format
- Bidirectional audio streaming
- Real-time transcription capabilities

## Actions

### Send SMS

Send text messages to phone numbers.

```typescript
{
  name: "SEND_SMS",
  description: "Send an SMS message to a phone number",
  examples: [
    ["Send a text to +15555551234 saying Hello!", "I'll send an SMS to +15555551234 with the message 'Hello!'"]
  ]
}
```

### Send MMS

Send multimedia messages with attachments.

```typescript
{
  name: "SEND_MMS", 
  description: "Send an MMS message with media attachments",
  examples: [
    ["Send a picture to +15555551234", "I'll send an MMS with the image to +15555551234"]
  ]
}
```

### Make Call

Initiate outbound voice calls.

```typescript
{
  name: "MAKE_CALL",
  description: "Make a voice call to a phone number",
  examples: [
    ["Call +15555551234", "I'll initiate a call to +15555551234"]
  ]
}
```

## Providers

### Conversation History Provider

Provides recent SMS conversation context for a phone number.

```typescript
{
  name: "conversationHistory",
  description: "Provides recent SMS conversation history with a phone number"
}
```

### Call State Provider

Provides information about active voice calls.

```typescript
{
  name: "callState", 
  description: "Provides current voice call state information"
}
```

## Events

The plugin emits standardized events that can be consumed by other plugins:

- `SMS_RECEIVED` - When an SMS/MMS is received
- `SMS_SENT` - When an SMS/MMS is sent successfully
- `CALL_RECEIVED` - When an incoming call is received
- `VOICE_STREAM_STARTED` - When voice streaming begins
- `VOICE_STREAM_ENDED` - When voice streaming ends

## Testing

The plugin includes a comprehensive testing suite covering both unit and end-to-end scenarios.

### Unit Tests

Unit tests use `vitest` to test individual components in isolation by mocking all external dependencies, including the Twilio client.

```bash
npm run test:unit
```

### E2E / Interactive Tests

The plugin features a robust end-to-end (E2E) test suite that runs against a live Twilio account and can be run in an interactive mode for real-world validation.

```bash
# Run all tests (unit and E2E)
npm test
```

**Prerequisites:**
- Valid Twilio credentials in your `.env` file.
- `TWILIO_TEST_PHONE_NUMBER` configured in `.env`.
- The webhook server must be publicly accessible for tests involving incoming messages or calls.

#### Interactive Test Mode

This mode allows you to test SMS and voice functionality with a real phone.

**To run:**
```bash
# From your project root
elizaos test --name "Interactive Test Mode"
```

**What it does:**
1.  **Starts a webhook server** to handle incoming replies and calls.
2.  **Sends a test SMS** to your `TWILIO_TEST_PHONE_NUMBER`.
3.  **Makes a test voice call** to the same number.
4.  **Waits for 30 seconds** for you to send an SMS *to* the Twilio number to test inbound message handling.

#### Local Testing with Ngrok

To test incoming webhooks on your local machine, use [ngrok](https://ngrok.com/) to expose your local server.

1.  **Start the ElizaOS agent:**
    ```bash
    elizaos start
    ```
    This will start the webhook server (typically on port 3000).

2.  **Expose the port with ngrok:**
    ```bash
    ngrok http 3000
    ```

3.  **Update your Twilio number's configuration:** In the Twilio console, set your number's webhooks to the public ngrok URL:
    -   **SMS:** `https://<your-ngrok-url>.ngrok.io/webhooks/twilio/sms`
    -   **Voice:** `https://<your-ngrok-url>.ngrok.io/webhooks/twilio/voice`

## Usage Example

```typescript
import { TwilioService } from '@elizaos/plugin-twilio';

// The service is automatically registered when the plugin loads
const twilioService = runtime.getService('twilio') as TwilioService;

// Send an SMS
const message = await twilioService.sendSms(
  '+15555551234',
  'Hello from your assistant!'
);

// Send an MMS with media
const mms = await twilioService.sendSms(
  '+15555551234', 
  'Check out this image!',
  ['https://example.com/image.png']
);

// Make a call with TwiML
const call = await twilioService.makeCall(
  '+15555551234',
  '<Response><Say>Hello from your assistant!</Say></Response>'
);
```

## Advanced Features

### Message Processing

- Automatic message chunking for long SMS (160 character limit)
- E.164 phone number validation and formatting
- Media attachment handling for MMS

### Voice Features

- Real-time audio streaming via WebSocket
- TwiML generation helpers
- Voice transcription support
- Call state management

### Conversation Management

- Automatic conversation history caching
- Context preservation across messages
- Integration with ElizaOS memory system

## Error Handling

The plugin implements comprehensive error handling:

- Graceful webhook server failures
- Twilio API error handling with retry logic
- Phone number validation
- Connection state management

## Troubleshooting

### SMS Not Delivered (Error 30034: Carrier Filtering)

A common issue with new Twilio numbers is that outbound SMS messages are blocked by mobile carriers (e.g., T-Mobile, AT&T, Verizon). This is a standard fraud prevention measure, not an error in the plugin.

**Symptoms:**
- The `sendSms` action succeeds without errors from the plugin.
- The message status in the Twilio console logs is `undelivered` or `failed` with error code `30034`.

**Immediate Solutions:**

1.  **Establish Two-Way Communication:** The easiest fix is to prove to the carrier that a legitimate conversation is occurring.
    -   Add your Twilio phone number to your personal phone's contacts.
    -   Send a text message (e.g., "Hello") *from your personal phone* **to** your Twilio number.
    -   This creates a conversation thread, signaling to the carrier that the number is trusted. Subsequent outbound messages are much more likely to be delivered.

2.  **Wait 24-48 Hours:** New numbers often have sending restrictions that are automatically lifted after a short period of low-volume use.

**Long-Term Solutions:**

For production applications, especially those with high volume, you must register your use case with carriers to ensure reliable delivery:
-   **A2P 10DLC Registration:** The US standard for Application-to-Person messaging over standard 10-digit long code numbers. This is essential for business messaging.
-   **Toll-Free Verification:** If using a toll-free number, it must be verified with Twilio to increase throughput and reduce the risk of filtering.

## Security Considerations

- Always use environment variables for credentials
- Implement webhook signature validation in production
- Use HTTPS for webhook URLs
- Restrict webhook endpoints to Twilio IP ranges

## Contributing

When contributing to the Twilio plugin:

1. Follow the ElizaOS development workflow
2. Write tests for new features
3. Update this documentation
4. Test with real Twilio credentials
5. Run `npm run format` before committing

## Cleaning Up

To remove all build artifacts and node modules, you can run the `clean` script:

```bash
npm run clean
```

## License

This plugin is part of the ElizaOS project and follows the same license terms.
