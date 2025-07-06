# @elizaos/plugin-twitter

Twitter/X bot integration plugin.

## Configuration

### Required environment variables:

```env
TWITTER_API_KEY=your_api_key
TWITTER_API_SECRET_KEY=your_api_secret_key
TWITTER_ACCESS_TOKEN=your_access_token
TWITTER_ACCESS_TOKEN_SECRET=your_access_token_secret
```

### Optional environment variables:

```env
TWITTER_TARGET_USERS=username1,username2        # Comma-separated list of target users
TWITTER_DRY_RUN=false                           # Set to true to simulate actions without posting
TWITTER_POST_ENABLE=false                       # Enable autonomous tweet posting
TWITTER_SEARCH_ENABLE=true                      # Enable timeline monitoring
TWITTER_POST_INTERVAL_MIN=90                    # Minimum minutes between posts
TWITTER_POST_INTERVAL_MAX=180                   # Maximum minutes between posts
```

## Installation

```bash
bun install @elizaos/plugin-twitter
```

## Integration

Import and register the plugin in Eliza configuration:

```typescript
import { twitterPlugin } from '@elizaos/plugin-twitter';

export default {
  plugins: [twitterPlugin],
  // ... other configuration
};
```

## Example Usage

```typescript
import { postAction } from '@elizaos/plugin-twitter';

// Tweet will be composed based on context and character limits
const result = await postAction.handler(runtime, message, state);

// Post with automatic content generation
await postAction.handler(runtime, message, state);

// Dry run mode (for testing)
process.env.TWITTER_DRY_RUN = 'true';
await postAction.handler(runtime, message, state);
```
