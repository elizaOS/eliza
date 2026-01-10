"""
elizaOS Twitter Plugin

Plugin definition for elizaOS runtime integration.
"""

from __future__ import annotations

from elizaos_plugin_twitter.client import TwitterClient, TwitterConfig
from elizaos_plugin_twitter.grok import GrokClient, GrokConfig


class TwitterPlugin:
    """
    Twitter/X plugin for elizaOS.

    Provides:
    - Twitter API v2 client for tweets, timelines, and interactions
    - xAI (Grok) model integration for AI-powered content generation
    """

    name = "twitter"
    description = "Twitter/X API v2 client with posting, interactions, and optional Grok AI integration"

    def __init__(
        self,
        twitter_config: TwitterConfig | None = None,
        grok_config: GrokConfig | None = None,
    ) -> None:
        """Initialize the plugin."""
        self._twitter_config = twitter_config or TwitterConfig.from_env()
        self._grok_config = grok_config or GrokConfig.from_env()
        self._twitter_client: TwitterClient | None = None
        self._grok_client: GrokClient | None = None

    @property
    def twitter(self) -> TwitterClient:
        """Get the Twitter client."""
        if self._twitter_client is None:
            self._twitter_client = TwitterClient(self._twitter_config)
        return self._twitter_client

    @property
    def grok(self) -> GrokClient | None:
        """Get the Grok client (if configured)."""
        if self._grok_config is None:
            return None
        if self._grok_client is None:
            self._grok_client = GrokClient(self._grok_config)
        return self._grok_client

    def has_grok(self) -> bool:
        """Check if Grok is configured."""
        return self._grok_config is not None

    async def close(self) -> None:
        """Close all clients."""
        if self._twitter_client:
            await self._twitter_client.close()
            self._twitter_client = None
        if self._grok_client:
            await self._grok_client.close()
            self._grok_client = None

    async def __aenter__(self) -> "TwitterPlugin":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()


def create_plugin(
    twitter_config: TwitterConfig | None = None,
    grok_config: GrokConfig | None = None,
) -> TwitterPlugin:
    """Create a new TwitterPlugin instance."""
    return TwitterPlugin(twitter_config, grok_config)


def get_twitter_plugin() -> TwitterPlugin:
    """Create a TwitterPlugin from environment variables."""
    return TwitterPlugin()

