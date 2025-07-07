# ElizaOS Farcaster Client

## Purpose

A plugin for ElizaOS that enables agent integration with the Farcaster social network.

## Key Features

- **Automated Posting**: Schedule and publish regular casts with configurable intervals
- **Engagement Monitoring**: Track mentions, replies, and interactions
- **Conversation Threading**: Build and maintain conversation context for natural interactions
- **Dry Run Mode**: Test functionality without actually posting to Farcaster
- **Configurable Settings**: Customize behavior via environment variables
- **Caching**: Efficient caching of profiles and casts for improved performance

## Installation

```bash
bun install @elizaos-plugins/client-farcaster
```

## Configuration

### Required Settings

| Parameter                      | Description                            |
| ------------------------------ | -------------------------------------- |
| `FARCASTER_NEYNAR_API_KEY`     | Neynar API key for accessing Farcaster |
| `FARCASTER_NEYNAR_SIGNER_UUID` | Signer UUID for your Farcaster account |
| `FARCASTER_FID`                | Your Farcaster FID (identifier)        |

### Optional Settings

Various parameters available including dry run mode, polling intervals, and post settings.

## Integration

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

## Example Usage

Custom templates can be defined in agent character configuration to customize cast generation and responses.
