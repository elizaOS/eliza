# ElizaOS Farcaster Plugin

A comprehensive plugin for ElizaOS that enables AI agents to fully participate in the Farcaster social network with posting, replying, and engagement capabilities.

## Overview

The ElizaOS Farcaster Plugin provides a complete integration with Farcaster, allowing AI agents to:

- **Post & Reply**: Create original casts and reply to conversations
- **Monitor Mentions**: Track and respond to mentions automatically
- **Engage with Content**: Like, recast, and interact with other users' posts
- **Context-Aware Responses**: Maintain conversation threads and context
- **Real-time Interaction**: Process interactions in real-time with configurable intervals

This plugin leverages the [Neynar API](https://neynar.com) and implements full ElizaOS service interfaces for seamless integration.

## Features

### Core Services
- **FarcasterService**: Main service managing agent connections and lifecycle
- **MessageService**: Implements `IMessageService` for sending/receiving messages
- **CastService**: Implements `IPostService` for creating and managing casts

### Actions
- **SEND_CAST**: Post casts based on user requests
- **REPLY_TO_CAST**: Reply to existing casts with context

### Providers
- **farcasterProfile**: Provides agent's Farcaster profile information
- **farcasterTimeline**: Supplies recent timeline casts for context

### Additional Features
- **Automated Posting**: Schedule and publish regular casts
- **Engagement Monitoring**: Track mentions and interactions
- **Conversation Threading**: Maintain conversation context
- **Metadata Tracking**: Store cast metadata for reference
- **Health Monitoring**: Built-in health check functionality
- **Caching**: Efficient caching for improved performance

## Installation

```bash
npm install @elizaos/plugin-farcaster
```

## Setup

### 1. Get Farcaster Credentials

1. **Create a Farcaster Account**: If you don't have one, sign up at [Warpcast](https://warpcast.com)
2. **Note your FID**: Find your Farcaster ID in your profile settings
3. **Get Neynar API Access**:
   - Sign up at [Neynar Developer Portal](https://dev.neynar.com/)
   - Create a new application
   - Copy your API key
4. **Create a Signer**:
   - In the Neynar dashboard, go to "Signers"
   - Create a new signer for your FID
   - Copy the Signer UUID

### 2. Configure Environment

Copy the example environment file and fill in your credentials:

```bash
cp env.example .env
```

Edit `.env` with your credentials:
```env
FARCASTER_FID=your-fid-here
FARCASTER_NEYNAR_API_KEY=your-api-key-here
FARCASTER_SIGNER_UUID=your-signer-uuid-here
FARCASTER_MODE=polling  # or 'webhook' for real-time processing
```

### 3. Webhook Setup (Recommended for Production)

For real-time interaction processing instead of polling, you can configure webhooks:

#### Step 1: Set Environment Variable
```env
FARCASTER_MODE=webhook
```

#### Step 2: Expose Your Server
If running locally, use ngrok to expose your server:
```bash
# Install ngrok if you haven't already
npm install -g ngrok

# Expose your local server (default port 3000)
ngrok http 3000
```

This will give you a URL like: `https://c7120f641530.ngrok-free.app`

#### Step 3: Configure Neynar Webhook
1. Go to [Neynar Webhook Dashboard](https://dev.neynar.com/webhook)
2. Click "New webhook"
3. Set the **Target URL** to: `https://your-ngrok-url.ngrok-free.app/farcaster/webhook`
   - Example: `https://c7120f641530.ngrok-free.app/farcaster/webhook`
4. Configure **Event Types**:
   - Select `cast.created`
5. Set **Filters**:
   - **Mentioned users**: Add your Farcaster username
   - **Parent cast authors**: Add your Farcaster username


#### Step 4: Test Webhook
Once configured, your agent will receive real-time notifications when:
- Someone mentions your agent
- Someone replies to your agent's casts

## Configuration

The plugin requires the following configurations, which can be set via environment variables or ElizaOS runtime settings:

### Required Settings

| Parameter                      | Description                            |
| ------------------------------ | -------------------------------------- |
| `FARCASTER_NEYNAR_API_KEY`     | Neynar API key for accessing Farcaster |
| `FARCASTER_SIGNER_UUID` | Signer UUID for your Farcaster account |
| `FARCASTER_FID`                | Your Farcaster FID (identifier)        |
| `FARCASTER_MODE`               | Interaction mode: `polling` or `webhook` |

### Optional Settings

| Parameter                  | Description                                         | Default |
| -------------------------- | --------------------------------------------------- | ------- |
| `FARCASTER_DRY_RUN`        | Run in simulation mode without posting (true/false) | false   |
| `MAX_CAST_LENGTH`          | Maximum length of casts                             | 320     |
| `FARCASTER_POLL_INTERVAL`  | Interval for checking mentions (minutes)            | 2       |
| `ENABLE_CAST`              | Enable automatic casting (true/false)               | true    |
| `CAST_INTERVAL_MIN`        | Minimum time between casts (minutes)                | 90      |
| `CAST_INTERVAL_MAX`        | Maximum time between casts (minutes)                | 180     |
| `ENABLE_ACTION_PROCESSING` | Enable processing interactions (true/false)         | false   |
| `ACTION_INTERVAL`          | Interval for processing actions (minutes)           | 5       |
| `CAST_IMMEDIATELY`         | Cast immediately on startup (true/false)            | false   |
| `MAX_ACTIONS_PROCESSING`   | Maximum actions to process in one cycle             | 1       |
| `ACTION_TIMELINE_TYPE`     | Type of timeline to use for actions                 | ForYou  |

## Usage

### Basic Integration

1. **In your agent's character file**:

```json
{
  "name": "MyFarcasterAgent",
  "bio": "An AI agent on Farcaster",
  "plugins": ["@elizaos/plugin-farcaster"],
  "settings": {
    "FARCASTER_FID": "123456",
    "FARCASTER_NEYNAR_API_KEY": "your-api-key",
    "FARCASTER_SIGNER_UUID": "your-signer-uuid",
    "FARCASTER_MODE": "webhook"
  }
}
```

2. **Start your agent**:

```bash
elizaos start --character path/to/character.json
```

### Using Actions

The plugin provides actions that can be triggered through natural language:

```
User: "Can you post about the new ElizaOS features on Farcaster?"
Agent: "I'll post about the new ElizaOS features on Farcaster now."
[Agent posts to Farcaster]

User: "Reply to that cast and thank them for the feedback"
Agent: "I'll reply with a thank you message."
[Agent replies to the cast]
```

### Programmatic Usage

```typescript
import farcasterPlugin from '@elizaos/plugin-farcaster';

// The plugin exports its components
const { actions, providers, services } = farcasterPlugin;

// Access specific services programmatically
const farcasterService = runtime.getService('farcaster');
const messageService = farcasterService.getMessageService(agentId);
const castService = farcasterService.getCastService(agentId);
```

### Customizing Cast Templates

You can customize the templates used for generating casts by providing custom templates in your agent character configuration:

```typescript
const myCharacter = {
  name: 'My Agent',
  bio: 'A helpful AI assistant on Farcaster',
  templates: {
    farcasterPostTemplate: `
      # Custom post template
      Write a thoughtful post about {{topic}} in the voice of {{agentName}}.
    `,
    farcasterMessageHandlerTemplate: `
      # Custom reply template
      Respond to {{currentPost}} as {{agentName}} would.
    `,
    farcasterShouldRespondTemplate: `
      # Custom response decision template
      Determine if {{agentName}} should respond to {{currentPost}}.
    `,
  },
};
```

## Development

### Build

```bash
npm run build
```

### Testing

```bash
npm test
```

### Development Mode

```bash
npm run dev
```

## Architecture

The plugin is organized into several core components:

### Services
- **FarcasterService**: Main service managing agent lifecycle and health monitoring
- **MessageService**: Handles sending/receiving messages, implements `IMessageService`
- **CastService**: Manages casts and interactions, implements `IPostService`

### Managers
- **FarcasterClient**: Base client for Neynar API interactions
- **FarcasterAgentManager**: Manages agent-specific connections
- **FarcasterInteractionManager**: Handles mentions and replies
- **FarcasterCastManager**: Manages autonomous casting

### Components
- **Actions**: User-triggered capabilities (SEND_CAST, REPLY_TO_CAST)
- **Providers**: Context providers for agent awareness
- **Event Handlers**: Metadata tracking and event processing

## Testing

The plugin includes comprehensive test coverage:

### Unit Tests
Located in `__tests__/unit/`:
- Service functionality tests
- Action validation tests
- Provider output tests

### E2E Tests
Located in `__tests__/e2e/`:
- Real account interactions
- Full conversation flows
- Error handling scenarios

### Running Tests

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run E2E tests (requires API keys)
npm run test:e2e

# Run with coverage
npm run test:coverage
```

For E2E tests, ensure your `.env` file contains valid API credentials.

## Dependencies

- [@neynar/nodejs-sdk](https://www.npmjs.com/package/@neynar/nodejs-sdk): Official SDK for Neynar API
- [@elizaos/core](https://www.npmjs.com/package/@elizaos/core): ElizaOS core framework
- [lru-cache](https://www.npmjs.com/package/lru-cache): Efficient caching
- [zod](https://www.npmjs.com/package/zod): Schema validation

## Contributing

Contributions are welcome! Please ensure all tests pass and add new tests for any new functionality.

## License

This plugin is part of the ElizaOS ecosystem and follows the same licensing terms.
