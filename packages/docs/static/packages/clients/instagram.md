# @elizaos/client-instagram

## Purpose

An Instagram client implementation for ElizaOS, enabling Instagram integration with support for media posting, comment handling, and interaction management.

## Key Features

- Instagram API integration using instagram-private-api
- Media post creation and scheduling
- Comment and interaction handling
- Profile management
- Media processing utilities
- Rate limiting and request queuing
- Session management and caching

## Installation

As this is a workspace package, it's installed as part of the ElizaOS monorepo:

```bash
bun install
```

## Configuration

The client requires environment variables for Instagram credentials, business account (optional), and posting configuration including intervals and action processing settings.

## Example Usage

### Basic Initialization

```typescript
import { InstagramClientInterface } from '@elizaos/client-instagram';

// Initialize the client
const instagramManager = await InstagramClientInterface.start(runtime);
```

### Posting Content

```typescript
// Post a single image
await instagramManager.post.createPost({
  media: [
    {
      type: 'IMAGE',
      url: 'path/to/image.jpg',
    },
  ],
  caption: 'Hello Instagram!',
});
```

### Handling Interactions

```typescript
// Handle comments
await instagramManager.interaction.handleComment({
  mediaId: 'media-123',
  comment: 'Great post!',
  userId: 'user-123',
});
```
