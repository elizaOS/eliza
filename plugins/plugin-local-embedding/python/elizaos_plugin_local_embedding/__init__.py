from elizaos_plugin_local_embedding.config import LocalEmbeddingConfig
from elizaos_plugin_local_embedding.errors import (
    ConfigError,
    EmbeddingError,
    LocalEmbeddingError,
    ModelLoadError,
    TokenizationError,
)
from elizaos_plugin_local_embedding.plugin import (
    PLUGIN_DESCRIPTION,
    PLUGIN_NAME,
    PLUGIN_VERSION,
    LocalEmbeddingManager,
    plugin,
)
from elizaos_plugin_local_embedding.types import (
    EmbeddingModelSpec,
    EmbeddingParams,
    EmbeddingResponse,
    ModelSpec,
    ModelSpecs,
    TokenDecodeParams,
    TokenDecodeResponse,
    TokenEncodeParams,
    TokenEncodeResponse,
    TokenizerConfig,
)

__version__ = "2.0.0"

__all__ = [
    "LocalEmbeddingManager",
    "LocalEmbeddingConfig",
    "LocalEmbeddingError",
    "ConfigError",
    "ModelLoadError",
    "EmbeddingError",
    "TokenizationError",
    "EmbeddingParams",
    "EmbeddingResponse",
    "TokenEncodeParams",
    "TokenEncodeResponse",
    "TokenDecodeParams",
    "TokenDecodeResponse",
    "EmbeddingModelSpec",
    "ModelSpec",
    "ModelSpecs",
    "TokenizerConfig",
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
    "PLUGIN_VERSION",
    "plugin",
]
