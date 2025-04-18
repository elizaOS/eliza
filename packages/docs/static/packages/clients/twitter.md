# Eliza Twitter/X Client

## Purpose

This package provides Twitter/X integration for the Eliza AI agent.

## Key Features

- Post generation and management
- Interaction handling (mentions, replies)
- Search functionality
- Twitter Spaces support with STT/TTS capabilities
- Media handling (images, videos)
- Approval workflow via Discord (optional)

## Configuration

Create or edit `.env` file with Twitter API credentials, client configuration, post generation settings, action processing settings, Spaces configuration, and approval workflow settings.

## Integration

```typescript
import { TwitterClientInterface } from '@elizaos/twitter';

const twitterPlugin = {
  name: 'twitter',
  description: 'Twitter client',
  clients: [TwitterClientInterface],
};

// Register with your Eliza runtime
runtime.registerPlugin(twitterPlugin);
```

## Example Usage

The client can automatically generate and post tweets, handle interactions (mentions, replies, quote tweets, direct messages), search Twitter for relevant topics, create and manage Twitter Spaces, and utilize an optional Discord-based approval system for tweets.
