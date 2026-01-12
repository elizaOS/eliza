"""
elizaOS xAI Plugin - Grok models and X (formerly Twitter) API integration.

This package provides:
- xAI Grok model client for text generation and embeddings
- X (formerly Twitter) API v2 client for social interactions
- Full parity with TypeScript and Rust implementations

Example:
    >>> from elizaos_plugin_xai import GrokClient, GrokConfig, TwitterClient, TwitterConfig
    >>> grok = GrokClient(GrokConfig.from_env())
    >>> result = await grok.generate_text(TextGenerationParams(prompt="Hello"))
"""

from elizaos_plugin_xai.actions import POST_ACTION
from elizaos_plugin_xai.client import TwitterClient, XClientError
from elizaos_plugin_xai.grok import GrokClient, GrokConfig, GrokError
from elizaos_plugin_xai.models import (
    TEXT_EMBEDDING_HANDLER,
    TEXT_LARGE_HANDLER,
    TEXT_SMALL_HANDLER,
    handle_text_embedding,
    handle_text_large,
    handle_text_small,
)
from elizaos_plugin_xai.plugin import XAIPlugin, create_plugin, get_xai_plugin, get_xai_elizaos_plugin
from elizaos_plugin_xai.types import (
    AuthMode,
    Mention,
    Photo,
    PollData,
    PollOption,
    Post,
    PostMetrics,
    Profile,
    TwitterConfig,
    Video,
)

__version__ = "1.0.0"

__all__ = [
    # Main plugin
    "XAIPlugin",
    "create_plugin",
    "get_xai_plugin",
    "get_xai_elizaos_plugin",
    # Actions
    "POST_ACTION",
    # Model handlers
    "TEXT_SMALL_HANDLER",
    "TEXT_LARGE_HANDLER",
    "TEXT_EMBEDDING_HANDLER",
    "handle_text_small",
    "handle_text_large",
    "handle_text_embedding",
    # Grok Client
    "GrokClient",
    "GrokConfig",
    "GrokError",
    # X Client
    "TwitterClient",
    "XClientError",
    "TwitterConfig",
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
