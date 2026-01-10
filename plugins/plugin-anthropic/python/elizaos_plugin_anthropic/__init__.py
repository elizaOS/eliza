"""
elizaOS Anthropic Plugin - Claude API client for text and object generation.

This package provides a strongly-typed Anthropic Claude API client for elizaOS,
supporting both text generation and structured JSON object generation.

Example:
    >>> from elizaos_plugin_anthropic import AnthropicClient, AnthropicConfig
    >>> config = AnthropicConfig.from_env()
    >>> client = AnthropicClient(config)
    >>> response = await client.generate_text_large("What is 2+2?")
    >>> print(response.text)
"""

from elizaos_plugin_anthropic.client import AnthropicClient
from elizaos_plugin_anthropic.config import AnthropicConfig
from elizaos_plugin_anthropic.errors import (
    AnthropicError,
    ApiError,
    ApiKeyError,
    ConfigError,
    JsonGenerationError,
    NetworkError,
    RateLimitError,
)
from elizaos_plugin_anthropic.models import Model, ModelSize
from elizaos_plugin_anthropic.types import (
    ContentBlock,
    Message,
    ObjectGenerationParams,
    ObjectGenerationResponse,
    Role,
    StopReason,
    TextGenerationParams,
    TextGenerationResponse,
    TokenUsage,
)

__version__ = "1.0.0"

__all__ = [
    # Client
    "AnthropicClient",
    # Config
    "AnthropicConfig",
    # Errors
    "AnthropicError",
    "ApiError",
    "ApiKeyError",
    "ConfigError",
    "JsonGenerationError",
    "NetworkError",
    "RateLimitError",
    # Models
    "Model",
    "ModelSize",
    # Types
    "ContentBlock",
    "Message",
    "ObjectGenerationParams",
    "ObjectGenerationResponse",
    "Role",
    "StopReason",
    "TextGenerationParams",
    "TextGenerationResponse",
    "TokenUsage",
]


