from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, TypeAlias

from elizaos.types.generated.eliza.v1 import model_pb2

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

LLMMode = model_pb2.LLMMode
ModelType = model_pb2.ModelType

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

ModelHandler = Callable[[IAgentRuntime, object], Awaitable[object]]

__all__ = [
    "LLMMode",
    "ModelType",
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
