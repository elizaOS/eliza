# ElizaOS Farcaster Client

A plugin for ElizaOS that enables agent integration with the Farcaster social network.

## Overview

The ElizaOS Farcaster Client allows AI agents to interact with the Farcaster social network by:

- Publishing original casts (posts)
- Responding to mentions and replies
- Interacting with other users' content
- Processing user engagement automatically

This client leverages the [Neynar API](https://neynar.com) to interact with Farcaster, providing a robust integration between ElizaOS agents and the Farcaster social graph.

## Features

- **Automated Posting**: Schedule and publish regular casts with configurable intervals
- **Engagement Monitoring**: Track mentions, replies, and interactions
- **Conversation Threading**: Build and maintain conversation context for natural interactions
- **Dry Run Mode**: Test functionality without actually posting to Farcaster
- **Configurable Settings**: Customize behavior via environment variables
- **Caching**: Efficient caching of profiles and casts for improved performance

## Installation

```bash
npm install @elizaos-plugins/client-farcaster
```

## Configuration

The client requires the following configurations, which can be set via environment variables or ElizaOS runtime settings:

### Required Settings

| Parameter | Description |
|-----------|-------------|
| `FARCASTER_NEYNAR_API_KEY` | Neynar API key for accessing Farcaster |
| `FARCASTER_NEYNAR_SIGNER_UUID` | Signer UUID for your Farcaster account |
| `FARCASTER_FID` | Your Farcaster FID (identifier) |

### Optional Settings

| Parameter | Description | Default |
|-----------|-------------|---------|
| `FARCASTER_DRY_RUN` | Run in simulation mode without posting (true/false) | false |
| `MAX_CAST_LENGTH` | Maximum length of casts | 320 |
| `FARCASTER_POLL_INTERVAL` | Interval for checking mentions (minutes) | 2 |
| `ENABLE_POST` | Enable automatic posting (true/false) | true |
| `POST_INTERVAL_MIN` | Minimum time between posts (minutes) | 90 |
| `POST_INTERVAL_MAX` | Maximum time between posts (minutes) | 180 |
| `ENABLE_ACTION_PROCESSING` | Enable processing interactions (true/false) | false |
| `ACTION_INTERVAL` | Interval for processing actions (minutes) | 5 |
| `POST_IMMEDIATELY` | Post immediately on startup (true/false) | false |
| `MAX_ACTIONS_PROCESSING` | Maximum actions to process in one cycle | 1 |
| `ACTION_TIMELINE_TYPE` | Type of timeline to use for actions | ForYou |

## Usage

### Basic Integration with ElizaOS

```typescript
import { ElizaOS } from '@elizaos/core';
import farcasterPlugin from '@elizaos-plugins/client-farcaster';

// Initialize ElizaOS
const elizaOs = new ElizaOS({
  // ElizaOS configuration
});

// Register the Farcaster plugin
elizaOs.registerPlugin(farcasterPlugin);

// Start ElizaOS
elizaOs.start();
```

### Customizing Cast Templates

You can customize the templates used for generating casts by providing custom templates in your agent character configuration:

```typescript
const myCharacter = {
  name: "My Agent",
  bio: "A helpful AI assistant on Farcaster",
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
    `
  }
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

The client is organized into several core components:

- **FarcasterClient**: Base client for interacting with the Farcaster network via Neynar
- **FarcasterPostManager**: Manages autonomous posting schedule and generation
- **FarcasterInteractionManager**: Handles mentions, replies, and other interactions
- **Memory Management**: Stores conversation context and history

## Dependencies

- [@neynar/nodejs-sdk](https://www.npmjs.com/package/@neynar/nodejs-sdk): Official SDK for Neynar API
- [@elizaos/core](https://www.npmjs.com/package/@elizaos/core): ElizaOS core framework

## Testing

The client includes comprehensive tests for:
- Cast creation and management
- Interaction handling
- Timeline processing

Run the tests with:

```bash
npm test
```
