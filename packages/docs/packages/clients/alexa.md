# ElizaOS Alexa Client Plugin

The Alexa Client Plugin enables ElizaOS agents to integrate with Amazon Alexa, allowing your ElizaOS character to interact with users through Alexa-enabled devices.

## Features

- Send proactive notifications to Alexa devices
- Connect ElizaOS agents to the Alexa Skills ecosystem
- Enable voice-based interaction with your ElizaOS character

## Installation

```bash
npm install @elizaos-plugins/client-alexa
```

## Prerequisites

Before using this plugin, you need to:

1. Create an Alexa Skill in the [Alexa Developer Console](https://developer.amazon.com/alexa/console/ask)
2. Set up the necessary permissions for Proactive Events
3. Obtain your Skill ID, Client ID, and Client Secret from the Alexa Developer Console

## Configuration

Add the following environment variables or settings to your ElizaOS configuration:

```
ALEXA_SKILL_ID=your-skill-id
ALEXA_CLIENT_ID=your-client-id
ALEXA_CLIENT_SECRET=your-client-secret
```

### Sending Proactive Events

The plugin currently supports sending proactive message alerts to Alexa devices. This allows your ElizaOS character to initiate conversations with users.

Example:

```typescript
// The plugin automatically sends a test notification when started
// Future versions will expose direct methods for sending custom notifications
```

## Development

To build the plugin from source:

```bash
# Install dependencies
npm install

# Build the plugin
npm run build

# Run tests
npm test

# Lint and format code
npm run lint
npm run format
```

## Settings Reference

| Setting Name | Description | Required |
|--------------|-------------|----------|
| ALEXA_SKILL_ID | The unique identifier for your Alexa skill | Yes |
| ALEXA_CLIENT_ID | OAuth2 client ID for your Alexa skill | Yes |
| ALEXA_CLIENT_SECRET | OAuth2 client secret for your Alexa skill | Yes |

## Limitations

- Currently, only one-way communication (proactive alerts) is supported
- Full conversational capabilities will be added in future releases
