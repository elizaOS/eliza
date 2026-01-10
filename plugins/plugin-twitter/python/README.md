# elizaOS Twitter/X Plugin (Python)

Python implementation of the elizaOS Twitter plugin with full Twitter API v2 support and xAI (Grok) model integration.

## Installation

```bash
pip install elizaos-plugin-twitter
```

Or for development:

```bash
pip install -e ".[dev]"
```

## Quick Start

### Twitter Client

```python
import asyncio
from elizaos_plugin_twitter import TwitterClient, TwitterConfig

async def main():
    # Create config from environment variables
    config = TwitterConfig.from_env()
    
    async with TwitterClient(config) as client:
        # Get authenticated user
        me = await client.me()
        print(f"Logged in as @{me.username}")
        
        # Post a tweet
        result = await client.post_tweet("Hello from elizaOS! 🤖")
        print(f"Posted tweet: {result.id}")
        
        # Get home timeline
        timeline = await client.get_home_timeline(max_results=10)
        for tweet in timeline.tweets:
            print(f"@{tweet.username}: {tweet.text[:50]}...")

asyncio.run(main())
```

### Grok AI Integration

```python
import asyncio
from elizaos_plugin_twitter import GrokClient, GrokConfig
from elizaos_plugin_twitter.grok import TextGenerationParams

async def main():
    config = GrokConfig.from_env()
    if config is None:
        print("XAI_API_KEY not configured")
        return
    
    async with GrokClient(config) as client:
        # Generate text
        params = TextGenerationParams(
            prompt="Write a witty tweet about AI agents",
            max_tokens=100,
        )
        result = await client.generate_text(params)
        print(f"Generated: {result.text}")
        
        # Stream text
        print("Streaming: ", end="")
        async for chunk in client.stream_text(params):
            print(chunk, end="", flush=True)
        print()

asyncio.run(main())
```

### Using the Plugin

```python
import asyncio
from elizaos_plugin_twitter import TwitterPlugin

async def main():
    async with TwitterPlugin() as plugin:
        # Access Twitter client
        me = await plugin.twitter.me()
        print(f"Twitter: @{me.username}")
        
        # Access Grok (if configured)
        if plugin.has_grok():
            models = await plugin.grok.list_models()
            print(f"Grok models: {len(models)}")

asyncio.run(main())
```

## Environment Variables

### Twitter API (Required)

```bash
# Authentication mode (env, oauth, or broker)
TWITTER_AUTH_MODE=env

# OAuth 1.0a credentials
TWITTER_API_KEY=your_api_key
TWITTER_API_SECRET_KEY=your_api_secret
TWITTER_ACCESS_TOKEN=your_access_token
TWITTER_ACCESS_TOKEN_SECRET=your_access_token_secret

# Optional: Bearer token for app-only auth
TWITTER_BEARER_TOKEN=your_bearer_token
```

### xAI/Grok (Optional)

```bash
XAI_API_KEY=your_xai_api_key
XAI_MODEL=grok-3
XAI_BASE_URL=https://api.x.ai/v1
```

### Feature Flags

```bash
TWITTER_DRY_RUN=false       # Simulate actions without posting
TWITTER_ENABLE_POST=false   # Enable autonomous posting
TWITTER_ENABLE_REPLIES=true # Enable reply handling
```

## API Reference

### TwitterClient

| Method | Description |
|--------|-------------|
| `me()` | Get authenticated user's profile |
| `get_profile(username)` | Get a user's profile |
| `get_user_id(username)` | Get a user's ID |
| `get_tweet(tweet_id)` | Get a single tweet |
| `post_tweet(text, ...)` | Post a new tweet |
| `delete_tweet(tweet_id)` | Delete a tweet |
| `like_tweet(tweet_id)` | Like a tweet |
| `unlike_tweet(tweet_id)` | Unlike a tweet |
| `retweet(tweet_id)` | Retweet a tweet |
| `unretweet(tweet_id)` | Undo a retweet |
| `get_home_timeline(...)` | Get home timeline |
| `get_user_tweets(...)` | Get user's tweets |
| `search_tweets(query, ...)` | Search tweets |
| `get_followers(...)` | Get user's followers |
| `get_following(...)` | Get accounts user follows |
| `follow_user(user_id)` | Follow a user |
| `unfollow_user(user_id)` | Unfollow a user |

### GrokClient

| Method | Description |
|--------|-------------|
| `generate_text(params)` | Generate text |
| `stream_text(params)` | Stream text generation |
| `create_embedding(params)` | Create text embedding |
| `list_models()` | List available models |

## Testing

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Run with coverage
pytest --cov=elizaos_plugin_twitter

# Type checking
mypy elizaos_plugin_twitter

# Linting
ruff check .
```

## License

MIT License - see [LICENSE](../LICENSE) for details.

