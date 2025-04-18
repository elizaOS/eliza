# @elizaos/plugin-twilio

## Purpose

A Twilio plugin for ElizaOS that enables SMS and voice call capabilities.

## Key Features

- SMS Messaging: Send, receive, and respond to SMS messages with natural conversation handling
- Voice Calls: Make and receive calls with natural voice conversations using ElevenLabs and speech recognition

## Installation

```bash
bun add @elizaos-plugins/plugin-twilio
```

## Configuration

1. Add plugin to character file with settings for actions and voice
2. Set environment variables in `.env` file (Twilio credentials, webhook configuration, ElevenLabs API key)
3. Configure webhooks in Twilio Console for voice and SMS
4. For local development, use ngrok to expose webhook endpoints

## Integration

- Connects with ElizaOS to enable SMS and voice communication
- Uses ElevenLabs for voice synthesis
- Uses Twilio's speech recognition capabilities for speech-to-text

## Example Usage

SMS Commands:

```
Send an SMS to +1234567890 saying Hello world!
Send SMS to +1234567890 about the weather forecast
```

Voice Call Commands:

```
Call +1234567890 and tell them about the latest updates
Call +1234567890 to say that we need to schedule a meeting
```
