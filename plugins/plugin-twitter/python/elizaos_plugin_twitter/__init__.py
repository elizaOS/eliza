"""
elizaOS Twitter/X Plugin - Twitter API v2 integration with xAI (Grok) model support.

This package provides:
- Type-safe async client for Twitter/X API v2
- xAI (Grok) model integration for AI-powered content
- Full parity with TypeScript and Rust implementations

Example:
    >>> from elizaos_plugin_twitter import TwitterClient, TwitterConfig
    >>> config = TwitterConfig.from_env()
    >>> async with TwitterClient(config) as client:
    ...     tweet = await client.post_tweet("Hello from elizaOS!")
    ...     print(f"Posted: {tweet.id}")
"""

from elizaos_plugin_twitter.client import TwitterClient, TwitterClientError
from elizaos_plugin_twitter.grok import GrokClient, GrokConfig, GrokError
from elizaos_plugin_twitter.plugin import TwitterPlugin, create_plugin, get_twitter_plugin
from elizaos_plugin_twitter.types import (
    AuthMode,
    Mention,
    Photo,
    PollData,
    PollOption,
    Profile,
    Tweet,
    TweetMetrics,
    TwitterConfig,
    Video,
)

__version__ = "1.3.0"

__all__ = [
    # Main plugin
    "TwitterPlugin",
    "create_plugin",
    "get_twitter_plugin",
    # Twitter Client
    "TwitterClient",
    "TwitterClientError",
    "TwitterConfig",
    # Grok Client
    "GrokClient",
    "GrokConfig",
    "GrokError",
    # Types - Core
    "Tweet",
    "Profile",
    "TweetMetrics",
    # Types - Media
    "Photo",
    "Video",
    "Mention",
    # Types - Polls
    "PollData",
    "PollOption",
    # Types - Config
    "AuthMode",
]

