from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any, TypeAlias

from elizaos.types.generated.eliza.v1 import model_pb2

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

LLMMode = model_pb2.LLMMode

# Keep protobuf enum available for compatibility
ModelTypeProto = model_pb2.ModelType


class ModelType:
    """Model type constants that match TypeScript for cross-language parity.

    Uses string values (not protobuf enum integers) to ensure consistent
    model handler registration keys across Python, TypeScript, and Rust.
    """

    # Legacy aliases for backwards compatibility
    SMALL = "TEXT_SMALL"
    MEDIUM = "TEXT_LARGE"
    LARGE = "TEXT_LARGE"

    # Primary text generation models
    TEXT_SMALL = "TEXT_SMALL"
    TEXT_LARGE = "TEXT_LARGE"
    TEXT_REASONING_SMALL = "TEXT_REASONING_SMALL"
    TEXT_REASONING_LARGE = "TEXT_REASONING_LARGE"
    TEXT_COMPLETION = "TEXT_COMPLETION"

    # Utility models
    TEXT_EMBEDDING = "TEXT_EMBEDDING"
    TEXT_TOKENIZER_ENCODE = "TEXT_TOKENIZER_ENCODE"
    TEXT_TOKENIZER_DECODE = "TEXT_TOKENIZER_DECODE"

    # Image models
    IMAGE = "IMAGE"
    IMAGE_DESCRIPTION = "IMAGE_DESCRIPTION"

    # Audio models
    TRANSCRIPTION = "TRANSCRIPTION"
    TEXT_TO_SPEECH = "TEXT_TO_SPEECH"
    AUDIO = "AUDIO"

    # Video models
    VIDEO = "VIDEO"

    # Object/structured output models
    OBJECT_SMALL = "OBJECT_SMALL"
    OBJECT_LARGE = "OBJECT_LARGE"


GenerateTextParams = model_pb2.GenerateTextParams
GenerateTextOptions = model_pb2.GenerateTextOptions
GenerateTextResult = model_pb2.GenerateTextResult
TokenUsage = model_pb2.TokenUsage
TextStreamChunk = model_pb2.TextStreamChunk
TokenizeTextParams = model_pb2.TokenizeTextParams
DetokenizeTextParams = model_pb2.DetokenizeTextParams
TextEmbeddingParams = model_pb2.TextEmbeddingParams
ImageGenerationParams = model_pb2.ImageGenerationParams
ImageDescriptionParams = model_pb2.ImageDescriptionParams
ImageDescriptionResult = model_pb2.ImageDescriptionResult
TranscriptionParams = model_pb2.TranscriptionParams
TextToSpeechParams = model_pb2.TextToSpeechParams
AudioProcessingParams = model_pb2.AudioProcessingParams
VideoProcessingParams = model_pb2.VideoProcessingParams
JSONSchema = model_pb2.JSONSchema
ObjectGenerationParams = model_pb2.ObjectGenerationParams
ResponseFormat = model_pb2.ResponseFormat

# Runtime-only types (not in proto)
ModelTypeName: TypeAlias = str
TextGenerationModelType: TypeAlias = str

# ModelHandler uses Any at runtime to avoid circular imports.
# Type checkers will see the proper type from the TYPE_CHECKING block.
if TYPE_CHECKING:
    ModelHandler = Callable[["IAgentRuntime", object], Awaitable[object]]
else:
    ModelHandler = Callable[[Any, object], Awaitable[object]]

__all__ = [
    "LLMMode",
    "ModelType",
    "ModelTypeProto",
    "ModelTypeName",
    "TextGenerationModelType",
    "GenerateTextParams",
    "GenerateTextOptions",
    "GenerateTextResult",
    "TokenUsage",
    "TextStreamChunk",
    "TokenizeTextParams",
    "DetokenizeTextParams",
    "TextEmbeddingParams",
    "ImageGenerationParams",
    "ImageDescriptionParams",
    "ImageDescriptionResult",
    "TranscriptionParams",
    "TextToSpeechParams",
    "AudioProcessingParams",
    "VideoProcessingParams",
    "JSONSchema",
    "ObjectGenerationParams",
    "ResponseFormat",
    "ModelHandler",
]
