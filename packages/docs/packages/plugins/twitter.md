# @elizaos/plugin-twitter

A plugin for Twitter/X integration using the official Twitter API v2, providing automated tweet posting, timeline reading, and social interactions.

## Overview

This plugin provides comprehensive Twitter/X integration for Eliza agents:

- 📝 Post tweets and replies
- 📖 Read home timeline and mentions
- 🔍 Search tweets and users
- ❤️ Like and retweet posts
- 🤝 Follow/unfollow users
- 💬 Natural conversation-aware responses
- 🔄 Automatic posting capabilities

## Installation

```bash
npm install @elizaos/plugin-twitter
```

## Quick Start

### 1. Get Twitter API Credentials

1. Go to [Twitter Developer Portal](https://developer.twitter.com)
2. Create a new app or use an existing one
3. Navigate to "Keys and tokens" section
4. You need **OAuth 1.0a** credentials (NOT OAuth 2.0):
   - API Key (Consumer Key)
   - API Key Secret (Consumer Secret)
   - Access Token
   - Access Token Secret

### 2. Configure Environment Variables

Add to your `.env` file:

```bash
# Required - Twitter API Credentials (OAuth 1.0a)
TWITTER_API_KEY=your_api_key
TWITTER_API_KEY_SECRET=your_api_key_secret
TWITTER_ACCESS_TOKEN=your_access_token
TWITTER_ACCESS_TOKEN_SECRET=your_access_token_secret

# Optional - Feature Flags
TWITTER_POLL_INTERVAL=120        # Seconds between timeline checks (default: 120)
TWITTER_MAX_TWEETS_PER_POLL=10   # Max tweets to process per poll (default: 10)
TWITTER_POST_INTERVAL_MIN=90     # Min minutes between posts (default: 90)
TWITTER_POST_INTERVAL_MAX=180    # Max minutes between posts (default: 180)
TWITTER_ENABLE_POST=false        # Enable automatic posting (default: false)
TWITTER_DRY_RUN=false           # Test mode - logs but doesn't post (default: false)
```

### 3. Register the Plugin

```typescript
import { twitterPlugin } from '@elizaos/plugin-twitter';

export default {
  plugins: [twitterPlugin],
  // ... other configuration
};
```

## Features

### Automatic Posting

Enable automatic posting to maintain an active Twitter presence:

```typescript
// Enable in .env
TWITTER_ENABLE_POST = true;
TWITTER_POST_INTERVAL_MIN = 90; // minimum minutes between posts
TWITTER_POST_INTERVAL_MAX = 180; // maximum minutes between posts
```

The agent will automatically generate and post contextually relevant tweets based on its character and recent interactions.

### Interactive Actions

The plugin provides several actions that can be triggered through conversation:

```typescript
// Post a tweet
'Can you tweet about the importance of open source?';

// Reply to a tweet
'Reply to the latest tweet from @user';

// Search tweets
'Search for tweets about AI agents';

// Timeline reading
'What are people saying on Twitter?';
```

### Tweet Composition

The plugin uses sophisticated templates to generate character-aware tweets:

- Considers recent conversation context
- Maintains character personality and style
- Respects Twitter's character limits
- Generates engaging, natural content
- Uses `postExamples` from character configuration as style references

The tweet generation process references your character's `postExamples` to maintain consistent voice and style. When composing tweets, the AI analyzes these examples to understand:

- Your typical tweet structure and length
- Common themes and topics you discuss
- Your writing style and tone
- How you engage with your audience

### API Rate Limit Management

The plugin automatically handles Twitter API rate limits:

- Configurable polling intervals
- Automatic retry with backoff
- Rate limit status monitoring

## Configuration

### Character Configuration

Your character file can include Twitter-specific settings:

```json
{
  "name": "MyAgent",
  "bio": "An AI agent interested in technology and innovation",
  "topics": ["AI", "blockchain", "open source"],
  "style": {
    "all": ["thoughtful", "informative", "engaging"],
    "chat": ["friendly", "helpful"],
    "post": ["concise", "insightful", "relevant"]
  },
  "postExamples": [
    "Just discovered an amazing open-source project that's revolutionizing how we think about AI collaboration. The future is being built in public! 🚀",
    "The beauty of blockchain isn't just decentralization - it's the trust it creates between strangers. We're moving from 'don't be evil' to 'can't be evil' systems.",
    "Today's thought: AI agents aren't replacing human creativity, they're amplifying it. We're entering an era of human-AI collaboration that will unlock possibilities we can't even imagine yet.",
    "Open source is more than code - it's a philosophy. When we share knowledge freely, we all rise together. What project inspired you recently? 🌟"
  ]
}
```

The `postExamples` array provides sample tweets that demonstrate your agent's voice and style. These examples help the AI generate tweets that are consistent with your character's personality and typical content.

### Plugin Actions

The plugin provides these core actions:

| Action           | Description               | Trigger Example                    |
| ---------------- | ------------------------- | ---------------------------------- |
| `POST_TWEET`     | Post a new tweet          | "Tweet about X"                    |
| `REPLY_TO_TWEET` | Reply to a specific tweet | "Reply to tweet [URL]"             |
| `LIKE_TWEET`     | Like a tweet              | "Like the latest tweet from @user" |
| `RETWEET`        | Retweet a post            | "Retweet [URL]"                    |
| `FOLLOW_USER`    | Follow a user             | "Follow @username"                 |
| `UNFOLLOW_USER`  | Unfollow a user           | "Unfollow @username"               |
| `SEARCH_TWEETS`  | Search for tweets         | "Search tweets about AI"           |

## Common Issues & Troubleshooting

### 403 Forbidden Error

**Problem**: Getting 403 errors when trying to post tweets.

**Solution**:

1. Your app needs "Read and write" permissions
2. Go to Twitter Developer Portal → Your app → Settings
3. Under "App permissions", select "Read and write"
4. **Important**: After changing permissions, regenerate your Access Token & Secret
5. Update your `.env` with the new tokens

### Authentication Confusion

**Problem**: Unsure which credentials to use.

**Solution**: You need OAuth 1.0a credentials (4 values):

```
✅ Use these from "Keys and tokens":
- API Key & Secret (Consumer Keys section)
- Access Token & Secret (Authentication Tokens section)

❌ Don't use OAuth 2.0:
- Client ID
- Client Secret
- Bearer Token
```

### Callback URL Required

**Problem**: Twitter requires a callback URL.

**Solution**: Add `http://localhost:3000/callback` in your app settings (not actually used, but required).

### Testing Without Posting

Use dry run mode to test without actually posting:

```bash
TWITTER_DRY_RUN=true
```

## Advanced Usage

### Custom Post Templates

You can customize how tweets are generated by modifying the tweet composition templates:

```typescript
const customTemplate = `
Generate a tweet about {{topic}} that:
- Reflects {{agentName}}'s personality
- Includes relevant hashtags
- Engages the audience
- Stays under 280 characters
`;
```

### Webhook Integration

For real-time interactions, you can set up Twitter webhooks (requires additional configuration).

### Multi-Account Management

To manage multiple Twitter accounts, run separate Eliza instances with different credentials.

## Security Best Practices

- **Never commit credentials**: Keep your `.env` file in `.gitignore`
- **Use environment variables**: Don't hardcode API keys
- **Rotate tokens regularly**: Regenerate access tokens periodically
- **Monitor usage**: Check your Twitter API dashboard for unusual activity
- **Implement rate limiting**: Respect Twitter's API limits

## API Reference

### Core Functions

```typescript
// Initialize Twitter client
const client = new TwitterClient({
  apiKey: process.env.TWITTER_API_KEY,
  apiKeySecret: process.env.TWITTER_API_KEY_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessTokenSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

// Post a tweet
await client.postTweet({ text: 'Hello world!' });

// Get home timeline
const timeline = await client.getHomeTimeline({ limit: 10 });

// Search tweets
const results = await client.searchTweets({
  query: 'AI agents',
  limit: 20,
});
```

## Migration from Previous Versions

If you're upgrading from an older version that used GraphQL endpoints:

1. **Update credentials**: Ensure you're using OAuth 1.0a tokens
2. **Update environment variables**: Some variable names have changed
3. **Test thoroughly**: The new version uses official Twitter API v2

## Contributing

Contributions are welcome! Please see the [CONTRIBUTING.md](https://github.com/ai16z/eliza/blob/main/CONTRIBUTING.md) file for more information.

## License

This plugin is part of the Eliza project and is licensed under the MIT License.
