from elizaos_plugin_gateway.client import GatewayClient, GatewayClientError
from elizaos_plugin_gateway.config import GatewayConfig
from elizaos_plugin_gateway.plugin import (
    GatewayPlugin,
    create_gateway_elizaos_plugin,
    create_plugin,
    get_gateway_plugin,
)
from elizaos_plugin_gateway.types import (
    ChatChoice,
    ChatCompletionResponse,
    ChatMessage,
    EmbeddingData,
    EmbeddingParams,
    EmbeddingResponse,
    ImageDescriptionParams,
    ImageDescriptionResult,
    ImageGenerationParams,
    ImageGenerationResponse,
    ImageGenerationResult,
    ImageQuality,
    ImageResponseData,
    ImageSize,
    ImageStyle,
    MessageRole,
    ObjectGenerationParams,
    TextGenerationParams,
    TokenUsage,
)

__version__ = "1.0.0"

__all__ = [
    # Main plugin
    "GatewayPlugin",
    "create_plugin",
    "get_gateway_plugin",
    "create_gateway_elizaos_plugin",
    # Client
    "GatewayClient",
    "GatewayClientError",
    # Configuration
    "GatewayConfig",
    # Enums
    "MessageRole",
    "ImageSize",
    "ImageQuality",
    "ImageStyle",
    # Request types
    "TextGenerationParams",
    "EmbeddingParams",
    "ObjectGenerationParams",
    "ImageGenerationParams",
    "ImageDescriptionParams",
    # Response types
    "TokenUsage",
    "ChatMessage",
    "ChatChoice",
    "ChatCompletionResponse",
    "EmbeddingData",
    "EmbeddingResponse",
    "ImageResponseData",
    "ImageGenerationResponse",
    "ImageGenerationResult",
    "ImageDescriptionResult",
]
