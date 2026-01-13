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
    "OllamaClient",
    "OllamaConfig",
    "OllamaError",
    "ConfigError",
    "ConnectionError",
    "ModelNotFoundError",
    "NetworkError",
    "EmbeddingParams",
    "EmbeddingResponse",
    "ModelInfo",
    "ObjectGenerationParams",
    "ObjectGenerationResponse",
    "TextGenerationParams",
    "TextGenerationResponse",
]
