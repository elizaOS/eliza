"""
elizaOS OpenRouter Plugin - Multi-model AI gateway client for text and object generation.

This package provides an OpenRouter API client for elizaOS,
supporting text generation, object generation, and embeddings
through multiple AI providers.

Example:
    >>> from elizaos_plugin_openrouter import OpenRouterClient, OpenRouterConfig
    >>> config = OpenRouterConfig.from_env()
    >>> client = OpenRouterClient(config)
    >>> response = await client.generate_text_large("What is 2+2?")
    >>> print(response.text)
"""

from elizaos_plugin_openrouter.client import OpenRouterClient
from elizaos_plugin_openrouter.config import OpenRouterConfig
from elizaos_plugin_openrouter.errors import (
    ApiKeyError,
    ConfigError,
    NetworkError,
    OpenRouterError,
    RateLimitError,
)
from elizaos_plugin_openrouter.types import (
    EmbeddingParams,
    EmbeddingResponse,
    ModelInfo,
    ObjectGenerationParams,
    ObjectGenerationResponse,
    TextGenerationParams,
    TextGenerationResponse,
    TokenUsage,
)

__version__ = "1.0.0"

__all__ = [
    # Client
    "OpenRouterClient",
    # Config
    "OpenRouterConfig",
    # Errors
    "OpenRouterError",
    "ApiKeyError",
    "ConfigError",
    "NetworkError",
    "RateLimitError",
    # Types
    "EmbeddingParams",
    "EmbeddingResponse",
    "ModelInfo",
    "ObjectGenerationParams",
    "ObjectGenerationResponse",
    "TextGenerationParams",
    "TextGenerationResponse",
    "TokenUsage",
]

