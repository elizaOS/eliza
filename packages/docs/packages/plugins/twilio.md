# @elizaos/plugin-twilio

A Twilio plugin for ElizaOS that enables SMS and voice call capabilities.

## Features

- 📱 SMS Messaging
  - Send SMS messages
  - Receive and respond to SMS messages
  - Natural conversation handling

- 📞 Voice Calls
  - Make outgoing calls
  - Receive incoming calls
  - Natural voice conversations using ElevenLabs
  - Speech recognition and response

## Installation

```bash
pnpm add @elizaos-plugins/plugin-twilio
```

## Configuration

1. Add the plugin to your character file:
```json
{
    "name": "your_character",
    "plugins": ["@elizaos-plugins/plugin-twilio"],
    "settings": {
        "actions": {
            "enabled": ["sms", "call"]
        },
        "voice": {
            "elevenlabs": {
                "voiceId": "your_voice_id",
                "stability": 0.3,
                "similarityBoost": 0.5,
                "style": 0.5,
                "useSpeakerBoost": false
            }
        }
    }
}
```

2. Set up environment variables in your `.env` file:

```bash
# Twilio Configuration
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=your_twilio_phone_number
TWILIO_CHARACTER=character.json

# Webhook Configuration
WEBHOOK_PORT=3004
WEBHOOK_BASE_URL=your_webhook_url

# ElevenLabs (for voice synthesis)
ELEVENLABS_XI_API_KEY=your_elevenlabs_api_key
```

### Webhook Configuration

1. Set up your webhook base URL in `.env`:
```env
WEBHOOK_BASE_URL=your_webhook_url  # e.g., https://your-domain.com
WEBHOOK_PORT=3004
```

2. Configure webhooks in Twilio Console:
   - Go to [Twilio Console](https://console.twilio.com)
   - Navigate to Phone Numbers - Manage - Active numbers
   - Select your Twilio phone number
   - Under "Voice & Fax" configuration:
     - Set "A Call Comes In" webhook to: `[WEBHOOK_BASE_URL]/webhook/voice`
     - Method: HTTP POST
   - Under "Messaging" configuration:
     - Set "A Message Comes In" webhook to: `[WEBHOOK_BASE_URL]/webhook/sms`
     - Method: HTTP POST

Example webhook URLs:
```
Voice: https://your-domain.com/webhook/voice
SMS: https://your-domain.com/webhook/sms
```

For local development:
1. Use ngrok to expose your local server:
```bash
ngrok http 3004
```
2. Update your `WEBHOOK_BASE_URL` with the ngrok URL
3. Update webhook URLs in Twilio Console with the ngrok URL

## Security

### Environment Variables
- Never commit `.env` files to version control
- Use secrets management in production (AWS Secrets Manager, Vault)
- Rotate credentials regularly
- Use environment-specific configurations

### Webhook Security
- Enable Twilio's request validation
- Use HTTPS for webhook endpoints
- Implement rate limiting
- Set up IP allowlisting for Twilio IPs
- Monitor webhook access logs

## Usage

### Interacting with the Agent

You can interact with the agent in two ways:

#### Via SMS
1. Save the Twilio phone number: TWILIO_PHONE_NUMBER
2. Send a text message to start a conversation
3. The agent will respond based on its character configuration
4. Continue the natural conversation via SMS

#### Via Voice Call
1. Call the Twilio phone number: TWILIO_PHONE_NUMBER
2. The agent will answer and start a conversation
3. Speak naturally - the agent uses speech recognition
4. The agent will respond with natural voice using ElevenLabs

### Sending Messages Through the Agent

Best Practices:
1. For direct messages, use "saying" or "telling"
2. For AI-generated content, use "about"
3. Always include the full phone number with "+" prefix
4. Keep messages concise (160 char limit)

#### SMS Commands

```
Send an SMS to +1234567890 saying Hello world!
Send SMS to +1234567890 about the weather forecast
```

#### Voice Call Commands

```
Call +1234567890 and tell them about the latest updates
Call +1234567890 to say that we need to schedule a meeting
```

## Development

```bash
# Install dependencies
pnpm install

# Build the plugin
pnpm build
```

## Webhook Setup

For local development, use ngrok or similar to expose your webhook:

```bash
ngrok http 3004
```

Then update your `WEBHOOK_BASE_URL` in `.env` with the ngrok URL.

## Notes

- Voice calls require ElevenLabs API key for text-to-speech
- Uses Twilio's built-in speech recognition capabilities for speech-to-text
- Messages are limited to 160 characters for SMS
- Voice responses are optimized for natural conversation flow
- All phone numbers must be in international format (+1234567890)
- The agent's responses are based on its configured character personality
- Incoming messages and calls are handled automatically through webhooks

## Important: A2P 10DLC Registration

If you're using US phone numbers (+1) for SMS messaging, you must complete A2P 10DLC registration:

- **Brand Registration**: Required one-time process through Twilio's Trust Hub
- **Campaign Registration**: Required for AI chatbot/automated messaging use case
- **Messaging Service**: Must link campaign to a Messaging Service with your phone numbers

Note: Voice-only functionality does not require A2P registration. Registration is mandatory for any SMS functionality to US numbers as of September 1, 2023.

See [Twilio's A2P 10DLC Documentation](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc) for registration process.

## License

This plugin is part of the Eliza project. See the main project repository for license information.

