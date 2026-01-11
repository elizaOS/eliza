"""
elizaOS xAI Plugin - Grok models and X (X) API integration.

This package provides:
- xAI Grok model client for text generation and embeddings
- X (X) API v2 client for social interactions
- Full parity with TypeScript and Rust implementations

Example:
    >>> from elizaos_plugin_xai import GrokClient, GrokConfig, XClient, XConfig
    >>> grok = GrokClient(GrokConfig.from_env())
    >>> result = await grok.generate_text(TextGenerationParams(prompt="Hello"))
"""

from elizaos_plugin_xai.client import XClient, XClientError
from elizaos_plugin_xai.grok import GrokClient, GrokConfig, GrokError
from elizaos_plugin_xai.plugin import XAIPlugin, create_plugin, get_xai_plugin
from elizaos_plugin_xai.types import (
    AuthMode,
    Mention,
    Photo,
    PollData,
    PollOption,
    Post,
    PostMetrics,
    Profile,
    Video,
    XConfig,
)

__version__ = "1.0.0"

__all__ = [
    # Main plugin
    "XAIPlugin",
    "create_plugin",
    "get_xai_plugin",
    # Grok Client
    "GrokClient",
    "GrokConfig",
    "GrokError",
    # X Client
    "XClient",
    "XClientError",
    "XConfig",
    # Types - Core
    "Post",
    "Profile",
    "PostMetrics",
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
