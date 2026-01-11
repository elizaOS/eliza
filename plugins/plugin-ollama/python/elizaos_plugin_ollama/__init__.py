"""
elizaOS Ollama Plugin - Local LLM client for text and object generation.

This package provides an Ollama API client for elizaOS,
supporting text generation, object generation, and embeddings
using locally-hosted models.

Example:
    >>> from elizaos_plugin_ollama import OllamaClient, OllamaConfig
    >>> config = OllamaConfig.from_env()
    >>> client = OllamaClient(config)
    >>> response = await client.generate_text_large("What is 2+2?")
    >>> print(response.text)
"""

from elizaos_plugin_ollama.client import OllamaClient
from elizaos_plugin_ollama.config import OllamaConfig
from elizaos_plugin_ollama.errors import (
    ConfigError,
    ConnectionError,
    ModelNotFoundError,
    NetworkError,
    OllamaError,
)
from elizaos_plugin_ollama.types import (
    EmbeddingParams,
    EmbeddingResponse,
    ModelInfo,
    ObjectGenerationParams,
    ObjectGenerationResponse,
    TextGenerationParams,
    TextGenerationResponse,
)

__version__ = "1.0.0"

__all__ = [
    # Client
    "OllamaClient",
    # Config
    "OllamaConfig",
    # Errors
    "OllamaError",
    "ConfigError",
    "ConnectionError",
    "ModelNotFoundError",
    "NetworkError",
    # Types
    "EmbeddingParams",
    "EmbeddingResponse",
    "ModelInfo",
    "ObjectGenerationParams",
    "ObjectGenerationResponse",
    "TextGenerationParams",
    "TextGenerationResponse",
]





