# ElizaOS Alexa Client Plugin

## Purpose

Enables ElizaOS agents to integrate with Amazon Alexa, allowing your ElizaOS character to interact with users through Alexa-enabled devices.

## Key Features

- Send proactive notifications to Alexa devices
- Connect ElizaOS agents to the Alexa Skills ecosystem
- Enable voice-based interaction with your ElizaOS character

## Installation

```bash
bun install @elizaos-plugins/client-alexa
```

## Configuration

Add the following environment variables or settings to your ElizaOS configuration:

```
ALEXA_SKILL_ID=your-skill-id
ALEXA_CLIENT_ID=your-client-id
ALEXA_CLIENT_SECRET=your-client-secret
```

## Integration

The plugin connects ElizaOS characters to Alexa-enabled devices, currently supporting one-way communication through proactive message alerts.

## Links

[Alexa Developer Console](https://developer.amazon.com/alexa/console/ask)
