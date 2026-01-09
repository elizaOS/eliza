"""
Model types for elizaOS.

This module defines types for LLM models and model handlers.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class ModelType(str, Enum):
    """Model type enumeration."""

    # Text generation models
    TEXT_SMALL = "TEXT_SMALL"
    TEXT_LARGE = "TEXT_LARGE"
    TEXT_REASONING_SMALL = "TEXT_REASONING_SMALL"
    TEXT_REASONING_LARGE = "TEXT_REASONING_LARGE"

    # Embedding models
    TEXT_EMBEDDING = "TEXT_EMBEDDING"

    # Image models
    IMAGE = "IMAGE"
    IMAGE_DESCRIPTION = "IMAGE_DESCRIPTION"

    # Audio models
    TRANSCRIPTION = "TRANSCRIPTION"
    TEXT_TO_SPEECH = "TEXT_TO_SPEECH"

    # Other models
    OBJECT_SMALL = "OBJECT_SMALL"
    OBJECT_LARGE = "OBJECT_LARGE"


# Type for model type names
ModelTypeName = str


class ModelSettings(BaseModel):
    """Settings for a specific model type."""

    model: str | None = Field(default=None, description="Model identifier")
    max_tokens: int | None = Field(default=None, alias="maxTokens", description="Maximum tokens")
    temperature: float | None = Field(default=None, description="Temperature setting")
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


# Model parameters map type - maps model types to their parameter types
ModelParamsMap = dict[ModelType, dict[str, Any]]

# Model result map type - maps model types to their result types
ModelResultMap = dict[ModelType, Any]


class GenerateTextParams(BaseModel):
    """Parameters for text generation."""

    prompt: str = Field(..., description="The prompt to generate from")
    system: str | None = Field(default=None, description="System prompt")
    temperature: float | None = Field(default=None, description="Temperature")
    max_tokens: int | None = Field(default=None, alias="maxTokens", description="Maximum tokens")
    stop: list[str] | None = Field(default=None, description="Stop sequences")

    model_config = {"populate_by_name": True, "extra": "allow"}


class GenerateTextOptions(BaseModel):
    """Options for text generation."""

    model_type: ModelType | None = Field(
        default=None, alias="modelType", description="Model type to use"
    )
    temperature: float | None = Field(default=None, description="Temperature")
    max_tokens: int | None = Field(default=None, alias="maxTokens", description="Maximum tokens")
    system: str | None = Field(default=None, description="System prompt override")

    model_config = {"populate_by_name": True, "extra": "allow"}


class GenerateTextResult(BaseModel):
    """Result of text generation."""

    text: str = Field(..., description="Generated text")
    usage: dict[str, int] | None = Field(default=None, description="Token usage statistics")

    model_config = {"populate_by_name": True}


class TextStreamChunk(BaseModel):
    """A chunk from a streaming text response."""

    text: str = Field(..., description="Text chunk")
    done: bool = Field(default=False, description="Whether this is the final chunk")

    model_config = {"populate_by_name": True}

