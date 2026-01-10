# @elizaos/plugin-bluesky

A BlueSky social network plugin for ElizaOS that enables agents to interact with BlueSky using the AT Protocol. This plugin provides full integration with BlueSky's features including posts, replies, likes, reposts, notifications, and direct messages.

## Table of Contents
- [Features](#features)
- [Installation](#installation)
- [Configuration](#configuration)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [API Reference](#api-reference)
- [Testing](#testing)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Resources](#resources)

## Features

### Core Capabilities
- 🔵 **Full AT Protocol Integration**: Built on the official `@atproto/api` SDK
- 💬 **Post Management**: Create, delete, and manage posts with rich text support
- 🔔 **Real-time Notifications**: Monitor mentions, replies, likes, reposts, follows, and quotes
- 🤖 **Automated Posting**: Schedule and publish posts automatically with configurable intervals
- 💭 **Smart Interactions**: AI-powered responses to mentions and conversations
- 📨 **Direct Messages**: Send and receive DMs through the chat.bsky API
- 🎯 **Intelligent Content**: AI-generated posts and responses using ElizaOS's model system
- ⚡ **Caching System**: LRU cache for optimized performance
- 🧪 **Comprehensive Testing**: Unit tests and E2E runtime tests included

### Technical Features
- Event-driven architecture with ElizaOS event system
- Service-based design pattern for modularity
- Automatic session management and authentication
- Rate limiting and error handling
- Dry run mode for testing without posting
- Memory integration for conversation context
- AT URI and DID support

## Installation

```bash
npm install @elizaos/plugin-bluesky
```

## Configuration

### Required Environment Variables

Create a `.env` file in your project root with the following variables:

```env
# Required - BlueSky Credentials
BLUESKY_HANDLE=your-handle.bsky.social    # Your full BlueSky handle
BLUESKY_PASSWORD=your-app-password         # App password (not main password!)

# Optional - Service Configuration
BLUESKY_SERVICE=https://bsky.social        # BlueSky API endpoint (default: https://bsky.social)
BLUESKY_DRY_RUN=false                      # Test mode - logs actions without posting (default: false)

# Optional - Content Settings
BLUESKY_MAX_POST_LENGTH=300                # Maximum characters per post (default: 300)

# Optional - Polling Intervals
BLUESKY_POLL_INTERVAL=60                   # Check notifications interval in seconds (default: 60 = 1 minute)
BLUESKY_ACTION_INTERVAL=120                # Process actions interval in seconds (default: 120 = 2 minutes)

# Optional - Automated Posting
BLUESKY_ENABLE_POSTING=true                # Enable automated posting (default: true)
BLUESKY_POST_IMMEDIATELY=false             # Post immediately on startup (default: false)
BLUESKY_POST_INTERVAL_MIN=1800             # Minimum time between posts in seconds (default: 1800 = 30 minutes)
BLUESKY_POST_INTERVAL_MAX=3600             # Maximum time between posts in seconds (default: 3600 = 1 hour)

# Optional - Feature Toggles
BLUESKY_ENABLE_ACTION_PROCESSING=true      # Enable processing of mentions/replies (default: true)
BLUESKY_MAX_ACTIONS_PROCESSING=5           # Max actions to process per interval (default: 5)
BLUESKY_ENABLE_DMS=true                    # Enable direct message functionality (default: true)
```

### Getting an App Password

For security, BlueSky requires app passwords instead of your main password:

1. Log in to [bsky.app](https://bsky.app)
2. Go to Settings → App Passwords
3. Click "Add App Password"
4. Name it (e.g., "ElizaOS Agent")
5. Copy the generated password
6. Use this password for `BLUESKY_PASSWORD` in your `.env`

## Quick Start

### 1. Install the Plugin

```bash
npm install @elizaos/plugin-bluesky
```

### 2. Configure Your Agent

Create or update your agent's character file:

```typescript
// agent/character.ts
import { BlueSkyPlugin } from '@elizaos/plugin-bluesky';

export const character = {
  name: "MyBlueSkyAgent",
  description: "An AI agent that interacts on BlueSky",
  plugins: [BlueSkyPlugin],
  // ... other character configuration
};
```

### 3. Set Environment Variables

Create a `.env` file:

```env
BLUESKY_HANDLE=myagent.bsky.social
BLUESKY_PASSWORD=xxxx-xxxx-xxxx-xxxx
ENABLE_POST=true
POST_IMMEDIATELY=true
```

### 4. Run Your Agent

```bash
elizaos start
```

Your agent will:
- Authenticate with BlueSky
- Start monitoring notifications
- Respond to mentions automatically
- Create posts based on your configuration

## Architecture

### Plugin Structure

```
plugin-bluesky/
├── src/
│   ├── index.ts              # Plugin definition and exports
│   ├── service.ts            # Main BlueSkyService
│   ├── client.ts             # AT Protocol client wrapper
│   ├── managers/
│   │   └── agent.ts          # BlueSkyAgentManager for automation
│   ├── services/
│   │   ├── MessageService.ts # Direct message handling
│   │   └── PostService.ts    # Post creation and management
│   └── common/
│       ├── config.ts         # Configuration validation
│       ├── constants.ts      # Constants and defaults
│       └── types.ts          # TypeScript types and schemas
```

### Core Components

#### BlueSkyService
The main service that coordinates all BlueSky functionality:
- Manages agent lifecycle
- Provides access to MessageService and PostService
- Handles authentication and session management

#### BlueSkyClient
Wrapper around the AT Protocol SDK:
- Handles all API calls to BlueSky
- Manages caching with LRU cache
- Provides error handling and retry logic

#### BlueSkyAgentManager
Manages automated agent behavior:
- Polls for notifications
- Triggers responses to mentions
- Schedules automated posts
- Processes pending actions

#### MessageService & PostService
Specialized services for different BlueSky features:
- MessageService: Handles DMs and conversations
- PostService: Manages post creation, deletion, and timeline

## API Reference

### BlueSkyService

```typescript
// Get the service from runtime
const service = runtime.getService('bluesky') as BlueSkyService;

// Access sub-services
const messageService = service.getMessageService(agentId);
const postService = service.getPostService(agentId);
```

### PostService

```typescript
// Get recent posts
const posts = await postService.getPosts({
  agentId: runtime.agentId,
  limit: 50,
  cursor: undefined
});

// Create a new post
const post = await postService.createPost({
  agentId: runtime.agentId,
  roomId: roomId,
  text: "Hello BlueSky! 🦋",
  replyTo: {
    uri: "at://did:plc:abc123/app.bsky.feed.post/xyz789",
    cid: "bafyreiabc123"
  }
});

// Delete a post
await postService.deletePost({
  agentId: runtime.agentId,
  postUri: post.uri
});
```

### MessageService

```typescript
// Get conversations
const conversations = await messageService.getConversations({
  agentId: runtime.agentId,
  limit: 50
});

// Get messages from a conversation
const messages = await messageService.getMessages({
  agentId: runtime.agentId,
  limit: 50
});

// Send a message (Note: Requires convoId)
const message = await messageService.sendMessage({
  agentId: runtime.agentId,
  roomId: roomId,
  text: "Hello!",
  type: MessageType.TEXT,
  recipients: ["user.bsky.social"]
});
```

### Events

The plugin emits these events that your agent can listen to:

```typescript
// Notification events
runtime.on('bluesky.mention_received', async (data) => {
  // Handle mention
});

runtime.on('bluesky.follow_received', async (data) => {
  // Handle new follower
});

runtime.on('bluesky.like_received', async (data) => {
  // Handle post like
});

runtime.on('bluesky.repost_received', async (data) => {
  // Handle repost
});

runtime.on('bluesky.quote_received', async (data) => {
  // Handle quote
});

// Action events
runtime.on('bluesky.should_respond', async (data) => {
  // Determine if agent should respond
});

runtime.on('bluesky.create_post', async (data) => {
  // Create a new post
});
```

## Testing

### Running Tests

```bash
# Run all tests (unit + E2E)
npm test

# Run unit tests only
npm run test:unit

# Run E2E tests only  
npm run test:e2e

# Run with coverage
npm run test:coverage

# Run specific test suite
elizaos test --name "BlueSky Plugin Tests"
```

### Test Structure

#### Unit Tests
Located in `__tests__/` directories, these test individual components in isolation:
- Uses Vitest framework
- Mocks external dependencies
- Tests pure functions and logic

#### E2E Tests
Located in `src/__tests__/e2e/suite.ts`, these test the full plugin with a live runtime:
- Tests real BlueSky API integration
- Validates end-to-end workflows
- Uses test prefixes to identify test posts

### Example E2E Test

```typescript
async testPostToBluesky(runtime: IAgentRuntime) {
  const service = runtime.getService('bluesky') as BlueSkyService;
  const postService = service.getPostService(runtime.agentId);
  
  const post = await postService.createPost({
    agentId: runtime.agentId,
    roomId: createUniqueUuid(runtime, 'test-room'),
    text: "[E2E TEST] Hello BlueSky!"
  });
  
  expect(post.uri).toBeDefined();
}
```

## Development

### Building from Source

```bash
# Clone the repository
git clone https://github.com/elizaos/elizaos.git
cd packages/plugin-bluesky

# Install dependencies
npm install

# Build the plugin
npm run build

# Run tests
npm test
```

### Creating Custom Actions

```typescript
// Example: Custom action for posting with hashtags
export const postWithHashtagsAction = {
  name: 'POST_WITH_HASHTAGS',
  description: 'Post to BlueSky with specific hashtags',
  handler: async (runtime, message, state) => {
    const service = runtime.getService('bluesky') as BlueSkyService;
    const postService = service.getPostService(runtime.agentId);
    
    const hashtags = ['#AI', '#ElizaOS', '#BlueSky'];
    const content = `${message.content} ${hashtags.join(' ')}`;
    
    const post = await postService.createPost({
      agentId: runtime.agentId,
      roomId: message.roomId,
      text: content
    });
    
    return {
      success: true,
      data: post
    };
  }
};
```

## Troubleshooting

### Common Issues

#### Authentication Errors
- **"Invalid identifier or password"**: Ensure you're using an app password, not your main password
- **"Rate limit exceeded"**: Increase polling intervals in configuration
- **"Session expired"**: The plugin will attempt to re-authenticate automatically

#### Posting Issues
- **"Post exceeds maximum length"**: Posts are limited to 300 characters by default
- **Posts not appearing**: Check `BLUESKY_DRY_RUN` is set to `false`
- **Duplicate posts**: Ensure only one agent instance is running

#### Connection Issues
- **"Network error"**: Verify internet connection and BlueSky service status
- **"Service unavailable"**: BlueSky may be down, check [status.bsky.app](https://status.bsky.app)

### Debug Mode

Enable debug logging:

```env
LOG_LEVEL=debug
```

### Dry Run Mode

Test without posting:

```env
BLUESKY_DRY_RUN=true
```

## Resources

- [BlueSky Documentation](https://docs.bsky.app)
- [AT Protocol Specifications](https://atproto.com)
- [ElizaOS Documentation](https://elizaos.github.io/eliza)
- [BlueSky API Reference](https://docs.bsky.app/docs/api)

## Support

- Discord: [Join ElizaOS Community](https://discord.gg/elizaos)
- GitHub Issues: [Report bugs or request features](https://github.com/elizaos/elizaos/issues)
- BlueSky: Follow [@elizaos.bsky.social](https://bsky.app/profile/elizaos.bsky.social)

## License

This plugin is part of the ElizaOS project and is licensed under the MIT License. See the [LICENSE](../../LICENSE) file for details.

## Contributing

Contributions are welcome! Please see the [ElizaOS Contributing Guide](https://github.com/elizaos/elizaos/blob/main/CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.
