# elizaOS Twitter/X Plugin (TypeScript)

TypeScript implementation of the elizaOS Twitter plugin with full Twitter API v2 support and xAI (Grok) model integration.

## Installation

```bash
npm install @elizaos/plugin-twitter
# or
bun add @elizaos/plugin-twitter
```

## Usage with elizaOS

```typescript
import { AgentRuntime } from "@elizaos/core";
import { TwitterPlugin } from "@elizaos/plugin-twitter";

const runtime = await AgentRuntime.create({
  plugins: [TwitterPlugin],
  // ... other options
});
```

## Standalone Client Usage

```typescript
import { Client } from "@elizaos/plugin-twitter/client";
import { createEnvProvider } from "@elizaos/plugin-twitter/client";

const client = new Client();

// Authenticate with environment credentials
await client.authenticate(createEnvProvider(runtime));

// Get authenticated user
const me = await client.me();
console.log(`Logged in as @${me.username}`);

// Post a tweet
const result = await client.sendTweet("Hello from elizaOS!");
console.log(`Posted tweet: ${result.data.data.id}`);

// Get home timeline
const tweets = await client.fetchHomeTimeline(10, []);
for (const tweet of tweets) {
  console.log(`@${tweet.username}: ${tweet.text}`);
}
```

## Grok AI Integration

```typescript
import { TwitterPlugin } from "@elizaos/plugin-twitter";
import { ModelType } from "@elizaos/core";

// In your elizaOS agent
const text = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Write a witty tweet about AI agents",
});
console.log(`Generated: ${text}`);

// Create embedding
const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
  text: "Hello, world!",
});
console.log(`Embedding dimensions: ${embedding.length}`);
```

## Plugin Features

### Actions

- **POST_TWEET** - Post tweets with AI-generated content
  - Similes: `TWEET`, `SEND_TWEET`, `TWITTER_POST`
  - Supports character-aware content generation

### Services

- **TwitterService** - Manages the complete Twitter client lifecycle
  - Post client - Autonomous tweeting
  - Interaction client - Mentions and replies
  - Timeline client - Timeline actions (likes, retweets)
  - Discovery client - Content discovery and engagement

### Model Handlers

When `XAI_API_KEY` is configured, the plugin provides model handlers:

- `ModelType.TEXT_SMALL` - Grok small model (grok-3-mini)
- `ModelType.TEXT_LARGE` - Grok large model (grok-3)
- `ModelType.TEXT_EMBEDDING` - Grok embeddings

## Configuration

### Environment Variables

```bash
# Twitter API (Required for TWITTER_AUTH_MODE=env)
TWITTER_API_KEY=your_api_key
TWITTER_API_SECRET_KEY=your_api_secret
TWITTER_ACCESS_TOKEN=your_access_token
TWITTER_ACCESS_TOKEN_SECRET=your_access_token_secret

# Authentication mode
TWITTER_AUTH_MODE=env  # env, oauth, or broker

# Feature flags
TWITTER_ENABLE_POST=false      # Enable autonomous posting
TWITTER_ENABLE_REPLIES=true    # Enable reply handling
TWITTER_ENABLE_ACTIONS=false   # Enable timeline actions
TWITTER_ENABLE_DISCOVERY=false # Enable discovery service

# Timing (all in minutes)
TWITTER_POST_INTERVAL_MIN=90
TWITTER_POST_INTERVAL_MAX=180
TWITTER_ENGAGEMENT_INTERVAL_MIN=20
TWITTER_ENGAGEMENT_INTERVAL_MAX=40

# Other options
TWITTER_DRY_RUN=false
TWITTER_MAX_TWEET_LENGTH=280

# xAI/Grok (Optional)
XAI_API_KEY=your_xai_api_key
XAI_MODEL=grok-3
XAI_BASE_URL=https://api.x.ai/v1
```

## API Reference

### Client Methods

| Method | Description |
|--------|-------------|
| `authenticate(provider)` | Authenticate with Twitter |
| `isLoggedIn()` | Check authentication status |
| `me()` | Get authenticated user's profile |
| `getProfile(username)` | Get a user's profile |
| `sendTweet(text, options?)` | Post a new tweet |
| `sendTweetV2(text, replyTo?, options?)` | Post with poll support |
| `deleteTweet(tweetId)` | Delete a tweet |
| `likeTweet(tweetId)` | Like a tweet |
| `retweet(tweetId)` | Retweet a tweet |
| `sendQuoteTweet(text, quotedTweetId)` | Quote tweet |
| `getTweet(id)` | Get a single tweet |
| `getTweets(user, maxTweets)` | Get user's tweets |
| `searchTweets(query, maxTweets, mode)` | Search tweets |
| `fetchHomeTimeline(count, seenIds)` | Get home timeline |
| `getFollowing(userId, maxProfiles)` | Get following |
| `getFollowers(userId, maxProfiles)` | Get followers |
| `followUser(username)` | Follow a user |

### Plugin Tests

The plugin includes built-in tests:

```typescript
tests: [
  {
    name: "twitter_plugin_tests",
    tests: [
      { name: "twitter_test_grok_api_connectivity", fn: async (runtime) => { ... } },
      { name: "twitter_test_text_generation", fn: async (runtime) => { ... } },
    ],
  },
]
```

Run with:
```bash
elizaos test
```

## Building

```bash
# Build all targets
bun run build.ts

# Development with hot reload
bun --hot build.ts

# Type check
tsc --noEmit
```

## Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test client/auth.test.ts
```

## License

MIT License - see [LICENSE](../LICENSE) for details.

