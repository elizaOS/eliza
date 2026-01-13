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

# Standalone modules (no elizaos dependency)
from elizaos_plugin_xai.client import TwitterClient, XClientError
from elizaos_plugin_xai.grok import GrokClient, GrokConfig, GrokError
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

# Base exports (always available)
__all__ = [
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

# elizaOS-dependent modules (optional - only available when elizaos is installed)
try:
    from elizaos_plugin_xai.actions import POST_ACTION  # noqa: F401
    from elizaos_plugin_xai.models import (  # noqa: F401
        TEXT_EMBEDDING_HANDLER,
        TEXT_LARGE_HANDLER,
        TEXT_SMALL_HANDLER,
        handle_text_embedding,
        handle_text_large,
        handle_text_small,
    )
    from elizaos_plugin_xai.plugin import (  # noqa: F401
        XAIPlugin,
        create_plugin,
        get_xai_elizaos_plugin,
        get_xai_plugin,
    )

    __all__.extend(
        [
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
        ]
    )
except ImportError:
    # elizaos not installed - plugin/action/model features not available
    # Standalone Grok and X clients are still usable
    pass
