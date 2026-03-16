"""
Model handlers for elizaOS xAI plugin.

Provides handlers for Grok models:
- TEXT_SMALL: grok-3-mini
- TEXT_LARGE: grok-3
- TEXT_EMBEDDING: grok-embedding
"""

from elizaos_plugin_xai.models.embedding import TEXT_EMBEDDING_HANDLER, handle_text_embedding
from elizaos_plugin_xai.models.text import (
    TEXT_LARGE_HANDLER,
    TEXT_SMALL_HANDLER,
    handle_text_large,
    handle_text_small,
)

__all__ = [
    "TEXT_SMALL_HANDLER",
    "TEXT_LARGE_HANDLER",
    "TEXT_EMBEDDING_HANDLER",
    "handle_text_small",
    "handle_text_large",
    "handle_text_embedding",
]
