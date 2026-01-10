"""
elizaOS Local AI Plugin - Local LLM inference using llama.cpp for text, embeddings, vision, and audio.

This package provides local AI capabilities without requiring external API calls.
"""

from elizaos_plugin_local_ai.plugin import (
    LocalAIPlugin,
    create_plugin,
    get_local_ai_plugin,
)
from elizaos_plugin_local_ai.types import (
    EmbeddingParams,
    EmbeddingResult,
    LocalAIConfig,
    ModelSpec,
    TextGenerationParams,
    TextGenerationResult,
    TranscriptionParams,
    TranscriptionResult,
)

__version__ = "1.0.0"

__all__ = [
    # Main plugin
    "LocalAIPlugin",
    "create_plugin",
    "get_local_ai_plugin",
    # Configuration
    "LocalAIConfig",
    "ModelSpec",
    # Request types
    "TextGenerationParams",
    "EmbeddingParams",
    "TranscriptionParams",
    # Response types
    "TextGenerationResult",
    "EmbeddingResult",
    "TranscriptionResult",
]
