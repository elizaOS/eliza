"""
elizaOS Google GenAI Plugin - Gemini API client for text generation, embeddings, and image analysis.

This package provides a strongly-typed Google Generative AI (Gemini) API client for elizaOS,
supporting text generation, embeddings, image analysis, and structured JSON object generation.

Example:
    >>> from elizaos_plugin_google_genai import GoogleGenAIClient, GoogleGenAIConfig
    >>> config = GoogleGenAIConfig.from_env()
    >>> client = GoogleGenAIClient(config)
    >>> response = await client.generate_text_large("What is 2+2?")
    >>> print(response.text)
"""

from elizaos_plugin_google_genai.client import GoogleGenAIClient
from elizaos_plugin_google_genai.config import GoogleGenAIConfig
from elizaos_plugin_google_genai.errors import (
    ApiError,
    ApiKeyError,
    ConfigError,
    GoogleGenAIError,
    InvalidParameterError,
    JsonGenerationError,
    NetworkError,
    RateLimitError,
    ServerError,
    TimeoutError,
)
from elizaos_plugin_google_genai.models import Model, ModelSize
from elizaos_plugin_google_genai.types import (
    ContentBlock,
    EmbeddingParams,
    EmbeddingResponse,
    ImageDescriptionParams,
    ImageDescriptionResponse,
    ObjectGenerationParams,
    ObjectGenerationResponse,
    TextGenerationParams,
    TextGenerationResponse,
    TokenUsage,
)

__version__ = "1.0.0"

# Plugin metadata
PLUGIN_NAME = "google-genai"
PLUGIN_DESCRIPTION = (
    "Google GenAI Gemini API client with text generation, embeddings, and image analysis support"
)
PLUGIN_VERSION = __version__


def create_client_from_env() -> GoogleGenAIClient:
    """
    Create a Google GenAI client from environment variables.

    This is a convenience function that loads configuration from environment
    variables and creates a client.

    Returns:
        Configured GoogleGenAIClient instance.

    Raises:
        ApiKeyError: If GOOGLE_GENERATIVE_AI_API_KEY is not set.
    """
    config = GoogleGenAIConfig.from_env()
    return GoogleGenAIClient(config)


__all__ = [
    # Convenience
    "create_client_from_env",
    # Plugin metadata
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
    "PLUGIN_VERSION",
    # Client
    "GoogleGenAIClient",
    # Config
    "GoogleGenAIConfig",
    # Errors
    "GoogleGenAIError",
    "ApiError",
    "ApiKeyError",
    "ConfigError",
    "InvalidParameterError",
    "JsonGenerationError",
    "NetworkError",
    "RateLimitError",
    "ServerError",
    "TimeoutError",
    # Models
    "Model",
    "ModelSize",
    # Types
    "ContentBlock",
    "EmbeddingParams",
    "EmbeddingResponse",
    "ImageDescriptionParams",
    "ImageDescriptionResponse",
    "ObjectGenerationParams",
    "ObjectGenerationResponse",
    "TextGenerationParams",
    "TextGenerationResponse",
    "TokenUsage",
]
