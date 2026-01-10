"""
Model types for elizaOS.

This module defines types for LLM models and model handlers.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class LLMMode(str, Enum):
    """
    LLM Mode for overriding model selection.

    - DEFAULT: Use the model type specified in the use_model call (no override)
    - SMALL: Override all text generation model calls to use TEXT_SMALL
    - LARGE: Override all text generation model calls to use TEXT_LARGE

    This is useful for cost optimization (force SMALL) or quality (force LARGE).
    While not recommended for production, it can be a fast way to make the agent run cheaper.

    Example:
        ```python
        runtime = AgentRuntime(
            character=my_character,
            llm_mode=LLMMode.SMALL,  # All LLM calls will use TEXT_SMALL
        )
        ```
    """

    DEFAULT = "DEFAULT"
    SMALL = "SMALL"
    LARGE = "LARGE"


class ModelType(str, Enum):
    """
    Model type enumeration.

    Defines the recognized types of models that the agent runtime can use.
    Values match the TypeScript implementation for cross-language compatibility.
    """

    # Legacy aliases (kept for backwards compatibility)
    SMALL = "TEXT_SMALL"
    MEDIUM = "TEXT_LARGE"
    LARGE = "TEXT_LARGE"

    # Text generation models
    TEXT_SMALL = "TEXT_SMALL"
    TEXT_LARGE = "TEXT_LARGE"
    TEXT_COMPLETION = "TEXT_COMPLETION"

    # Reasoning models (note: values are REASONING_*, not TEXT_REASONING_*)
    TEXT_REASONING_SMALL = "REASONING_SMALL"
    TEXT_REASONING_LARGE = "REASONING_LARGE"

    # Tokenization models
    TEXT_TOKENIZER_ENCODE = "TEXT_TOKENIZER_ENCODE"
    TEXT_TOKENIZER_DECODE = "TEXT_TOKENIZER_DECODE"

    # Embedding models
    TEXT_EMBEDDING = "TEXT_EMBEDDING"

    # Image models
    IMAGE = "IMAGE"
    IMAGE_DESCRIPTION = "IMAGE_DESCRIPTION"

    # Audio models
    TRANSCRIPTION = "TRANSCRIPTION"
    TEXT_TO_SPEECH = "TEXT_TO_SPEECH"
    AUDIO = "AUDIO"

    # Video models
    VIDEO = "VIDEO"

    # Object generation models
    OBJECT_SMALL = "OBJECT_SMALL"
    OBJECT_LARGE = "OBJECT_LARGE"


# Type for model type names - allows string for extensibility
ModelTypeName = str

# Union type of text generation model types
TextGenerationModelType = str  # TEXT_SMALL, TEXT_LARGE, REASONING_*, TEXT_COMPLETION


class ModelSettings(BaseModel):
    """Settings for a specific model type."""

    model: str | None = Field(default=None, description="Model identifier")
    max_tokens: int | None = Field(default=None, alias="maxTokens", description="Maximum tokens")
    temperature: float | None = Field(default=None, description="Temperature setting")
    top_p: float | None = Field(default=None, alias="topP", description="Top P setting")
    top_k: int | None = Field(default=None, alias="topK", description="Top K setting")
    min_p: float | None = Field(default=None, alias="minP", description="Minimum P setting")
    seed: int | None = Field(default=None, description="Random seed for reproducibility")
    repetition_penalty: float | None = Field(
        default=None, alias="repetitionPenalty", description="Repetition penalty"
    )
    frequency_penalty: float | None = Field(
        default=None, alias="frequencyPenalty", description="Frequency penalty"
    )
    presence_penalty: float | None = Field(
        default=None, alias="presencePenalty", description="Presence penalty"
    )
    stop_sequences: list[str] | None = Field(
        default=None, alias="stopSequences", description="Stop sequences"
    )

    model_config = {"populate_by_name": True, "extra": "allow"}


# Model parameters map type - maps model types to their parameter types
ModelParamsMap = dict[ModelType, dict[str, Any]]

# Model result map type - maps model types to their result types
ModelResultMap = dict[ModelType, Any]

# Stream chunk callback type
StreamChunkCallback = Callable[[str, str | None], Awaitable[None] | None]


class GenerateTextParams(BaseModel):
    """
    Parameters for generating text using a language model.

    This structure is passed to `runtime.use_model` for text generation models.
    """

    prompt: str = Field(..., description="The input prompt for text generation")
    max_tokens: int | None = Field(
        default=None, alias="maxTokens", description="Maximum tokens to generate"
    )
    min_tokens: int | None = Field(
        default=None, alias="minTokens", description="Minimum tokens to generate"
    )
    temperature: float | None = Field(default=None, description="Controls randomness (0.0-1.0)")
    top_p: float | None = Field(
        default=None, alias="topP", description="Nucleus sampling parameter (0.0-1.0)"
    )
    top_k: int | None = Field(
        default=None, alias="topK", description="Limits highest-probability tokens considered"
    )
    min_p: float | None = Field(
        default=None, alias="minP", description="Minimum probability threshold (0.0-1.0)"
    )
    seed: int | None = Field(default=None, description="Random seed for reproducible outputs")
    repetition_penalty: float | None = Field(
        default=None, alias="repetitionPenalty", description="Repetition penalty (1.0 = no penalty)"
    )
    frequency_penalty: float | None = Field(
        default=None, alias="frequencyPenalty", description="Penalizes based on frequency"
    )
    presence_penalty: float | None = Field(
        default=None, alias="presencePenalty", description="Penalizes based on presence"
    )
    stop_sequences: list[str] | None = Field(
        default=None, alias="stopSequences", description="Sequences to stop generation"
    )
    user: str | None = Field(default=None, description="User identifier for tracking/analytics")
    response_format: dict[str, str] | str | None = Field(
        default=None, alias="responseFormat", description="Response format specification"
    )
    stream: bool | None = Field(default=None, description="Enable streaming mode")

    model_config = {"populate_by_name": True, "extra": "allow"}


class GenerateTextOptions(BaseModel):
    """Options for the simplified generateText API."""

    include_character: bool | None = Field(
        default=None, alias="includeCharacter", description="Include character personality"
    )
    model_type: str | None = Field(default=None, alias="modelType", description="Model type to use")
    max_tokens: int | None = Field(default=None, alias="maxTokens", description="Maximum tokens")
    temperature: float | None = Field(default=None, description="Temperature")
    top_p: float | None = Field(default=None, alias="topP", description="Top P setting")
    frequency_penalty: float | None = Field(
        default=None, alias="frequencyPenalty", description="Frequency penalty"
    )
    presence_penalty: float | None = Field(
        default=None, alias="presencePenalty", description="Presence penalty"
    )
    stop_sequences: list[str] | None = Field(
        default=None, alias="stopSequences", description="Stop sequences"
    )

    model_config = {"populate_by_name": True, "extra": "allow"}


class GenerateTextResult(BaseModel):
    """Result of text generation."""

    text: str = Field(..., description="Generated text")

    model_config = {"populate_by_name": True}


class TokenUsage(BaseModel):
    """Token usage information from a model response."""

    prompt_tokens: int = Field(..., alias="promptTokens", description="Tokens in input prompt")
    completion_tokens: int = Field(
        ..., alias="completionTokens", description="Tokens in generated response"
    )
    total_tokens: int = Field(..., alias="totalTokens", description="Total tokens used")

    model_config = {"populate_by_name": True}


class TextStreamChunk(BaseModel):
    """A chunk from a streaming text response."""

    text: str = Field(..., description="Text chunk")
    done: bool = Field(default=False, description="Whether this is the final chunk")

    model_config = {"populate_by_name": True}


class TokenizeTextParams(BaseModel):
    """Parameters for text tokenization."""

    prompt: str = Field(..., description="Text to tokenize")
    model_type: str = Field(..., alias="modelType", description="Model type for tokenization")

    model_config = {"populate_by_name": True}


class DetokenizeTextParams(BaseModel):
    """Parameters for detokenizing (tokens to text)."""

    tokens: list[int] = Field(..., description="Tokens to convert to text")
    model_type: str = Field(..., alias="modelType", description="Model type for detokenization")

    model_config = {"populate_by_name": True}


class TextEmbeddingParams(BaseModel):
    """Parameters for text embedding."""

    text: str = Field(..., description="Text to create embeddings for")

    model_config = {"populate_by_name": True}


class ImageGenerationParams(BaseModel):
    """Parameters for image generation."""

    prompt: str = Field(..., description="Prompt describing the image")
    size: str | None = Field(default=None, description="Image dimensions")
    count: int | None = Field(default=None, description="Number of images to generate")

    model_config = {"populate_by_name": True}


class ImageDescriptionParams(BaseModel):
    """Parameters for image description."""

    image_url: str = Field(..., alias="imageUrl", description="URL of the image")
    prompt: str | None = Field(default=None, description="Optional guiding prompt")

    model_config = {"populate_by_name": True}


class ImageDescriptionResult(BaseModel):
    """Result of image description."""

    title: str = Field(..., description="Image title")
    description: str = Field(..., description="Image description")

    model_config = {"populate_by_name": True}


class TranscriptionParams(BaseModel):
    """Parameters for audio transcription."""

    audio_url: str = Field(..., alias="audioUrl", description="URL of audio file")
    prompt: str | None = Field(default=None, description="Optional guiding prompt")

    model_config = {"populate_by_name": True}


class TextToSpeechParams(BaseModel):
    """Parameters for text-to-speech."""

    text: str = Field(..., description="Text to convert to speech")
    voice: str | None = Field(default=None, description="Voice to use")
    speed: float | None = Field(default=None, description="Speaking speed")

    model_config = {"populate_by_name": True}


class ObjectGenerationParams(BaseModel):
    """Parameters for object generation models."""

    prompt: str = Field(..., description="Prompt describing the object")
    schema_def: dict[str, Any] | None = Field(
        default=None, alias="schema", description="JSON schema for validation"
    )
    output: str | None = Field(
        default=None, description="Output type: 'object', 'array', or 'enum'"
    )
    enum_values: list[str] | None = Field(
        default=None, alias="enumValues", description="Allowed values for enum type"
    )
    model_type: str | None = Field(default=None, alias="modelType", description="Model type")
    temperature: float | None = Field(default=None, description="Temperature")
    max_tokens: int | None = Field(default=None, alias="maxTokens", description="Maximum tokens")
    stop_sequences: list[str] | None = Field(
        default=None, alias="stopSequences", description="Stop sequences"
    )

    model_config = {"populate_by_name": True, "extra": "allow"}


class ModelHandler(BaseModel):
    """Model handler registration info."""

    provider: str = Field(..., description="Provider name that registered this handler")
    priority: int | None = Field(
        default=None, description="Priority for selection (higher preferred)"
    )
    registration_order: int | None = Field(
        default=None, alias="registrationOrder", description="Order of registration"
    )

    model_config = {"populate_by_name": True}
