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

PLUGIN_NAME = "google-genai"
PLUGIN_DESCRIPTION = (
    "Google GenAI Gemini API client with text generation, embeddings, and image analysis support"
)
PLUGIN_VERSION = __version__


def create_client_from_env() -> GoogleGenAIClient:
    config = GoogleGenAIConfig.from_env()
    return GoogleGenAIClient(config)


__all__ = [
    "create_client_from_env",
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
    "PLUGIN_VERSION",
    "GoogleGenAIClient",
    "GoogleGenAIConfig",
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
    "Model",
    "ModelSize",
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
