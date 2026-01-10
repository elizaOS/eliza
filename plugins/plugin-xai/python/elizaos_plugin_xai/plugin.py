"""
elizaOS xAI Plugin

Plugin definition for elizaOS runtime integration.
"""

from __future__ import annotations

from elizaos_plugin_xai.client import XClient, XConfig
from elizaos_plugin_xai.grok import GrokClient, GrokConfig


class XAIPlugin:
    """
    xAI plugin for elizaOS.

    Provides:
    - xAI Grok model client for text generation and embeddings
    - X (Twitter) API v2 client for social interactions
    """

    name = "xai"
    description = "xAI Grok models and X (Twitter) API integration"

    def __init__(
        self,
        grok_config: GrokConfig | None = None,
        x_config: XConfig | None = None,
    ) -> None:
        """Initialize the plugin."""
        self._grok_config = grok_config or GrokConfig.from_env()
        self._x_config = x_config or XConfig.from_env()
        self._grok_client: GrokClient | None = None
        self._x_client: XClient | None = None

    @property
    def grok(self) -> GrokClient | None:
        """Get the Grok client (if configured)."""
        if self._grok_config is None:
            return None
        if self._grok_client is None:
            self._grok_client = GrokClient(self._grok_config)
        return self._grok_client

    @property
    def x(self) -> XClient:
        """Get the X client."""
        if self._x_client is None:
            self._x_client = XClient(self._x_config)
        return self._x_client

    def has_grok(self) -> bool:
        """Check if Grok is configured."""
        return self._grok_config is not None

    async def close(self) -> None:
        """Close all clients."""
        if self._grok_client:
            await self._grok_client.close()
            self._grok_client = None
        if self._x_client:
            await self._x_client.close()
            self._x_client = None

    async def __aenter__(self) -> "XAIPlugin":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()


def create_plugin(
    grok_config: GrokConfig | None = None,
    x_config: XConfig | None = None,
) -> XAIPlugin:
    """Create a new XAIPlugin instance."""
    return XAIPlugin(grok_config, x_config)


def get_xai_plugin() -> XAIPlugin:
    """Create an XAIPlugin from environment variables."""
    return XAIPlugin()
