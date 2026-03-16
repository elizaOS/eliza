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
from elizaos_plugin_local_ai.xml_parser import (
    build_xml_response,
    escape_xml,
    extract_xml_tag,
    parse_simple_xml,
    sanitize_for_xml,
    unescape_xml,
    wrap_in_cdata,
)

__version__ = "1.0.0"

__all__ = [
    "LocalAIPlugin",
    "create_plugin",
    "get_local_ai_plugin",
    "LocalAIConfig",
    "ModelSpec",
    "TextGenerationParams",
    "EmbeddingParams",
    "TranscriptionParams",
    "TextGenerationResult",
    "EmbeddingResult",
    "TranscriptionResult",
    "extract_xml_tag",
    "unescape_xml",
    "escape_xml",
    "wrap_in_cdata",
    "parse_simple_xml",
    "sanitize_for_xml",
    "build_xml_response",
]
