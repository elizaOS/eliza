# @elizaos/client-instagram

An Instagram client implementation for ElizaOS, enabling Instagram integration with support for media posting, comment handling, and interaction management.

## Features

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
pnpm install
```

## Configuration

The client requires the following environment variables:

```bash
# Instagram Credentials
INSTAGRAM_USERNAME=your_username
INSTAGRAM_PASSWORD=your_password
INSTAGRAM_APP_ID=your_app_id
INSTAGRAM_APP_SECRET=your_app_secret

# Optional Business Account
INSTAGRAM_BUSINESS_ACCOUNT_ID=your_business_account_id

# Posting Configuration
POST_INTERVAL_MIN=90        # Minimum interval between posts (minutes)
POST_INTERVAL_MAX=180       # Maximum interval between posts (minutes)
ENABLE_ACTION_PROCESSING=true
ACTION_INTERVAL=5           # Minutes between action processing
MAX_ACTIONS_PROCESSING=1    # Maximum actions to process per interval
```

## Usage

### Basic Initialization

```typescript
import { InstagramClientInterface } from '@elizaos/client-instagram';

// Initialize the client
const instagramManager = await InstagramClientInterface.start(runtime);
```

### Posting Content

All posts on Instagram must include media (image, video, or carousel):

```typescript
// Post a single image
await instagramManager.post.createPost({
  media: [{
    type: 'IMAGE',
    url: 'path/to/image.jpg'
  }],
  caption: 'Hello Instagram!'
});

// Post a carousel
await instagramManager.post.createPost({
  media: [
    { type: 'IMAGE', url: 'path/to/image1.jpg' },
    { type: 'IMAGE', url: 'path/to/image2.jpg' }
  ],
  caption: 'Check out these photos!'
});
```

### Handling Interactions

```typescript
// Handle comments
await instagramManager.interaction.handleComment({
  mediaId: 'media-123',
  comment: 'Great post!',
  userId: 'user-123'
});

// Like media
await instagramManager.interaction.likeMedia('media-123');
```

## Key Components

1. ClientBase
    - Handles authentication and session management
    - Manages API rate limiting
    - Provides core API functionality


2. PostClient
    - Manages media uploads
    - Handles post scheduling
    - Processes media before upload


3. InteractionClient
    - Handles comments and likes
    - Manages user interactions
    - Processes notifications


