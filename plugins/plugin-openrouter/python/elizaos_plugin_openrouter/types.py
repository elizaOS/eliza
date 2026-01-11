"""
Core types for the OpenRouter API.

All types use Pydantic for strong validation and type safety.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class TokenUsage(BaseModel):
    """Token usage information from API response."""

    prompt_tokens: int
    completion_tokens: int
    total_tokens: int

    def total(self) -> int:
        """Get total tokens used."""
        return self.total_tokens


class TextGenerationParams(BaseModel):
    """Parameters for text generation."""

    prompt: str
    system: str | None = None
    temperature: float | None = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int | None = None
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)
    frequency_penalty: float | None = None
    presence_penalty: float | None = None
    stop: list[str] | None = None

    def with_system(self, system: str) -> TextGenerationParams:
        """Set the system prompt."""
        return self.model_copy(update={"system": system})

    def with_temperature(self, temperature: float) -> TextGenerationParams:
        """Set temperature."""
        return self.model_copy(update={"temperature": temperature})


class TextGenerationResponse(BaseModel):
    """Response from text generation."""

    text: str
    model: str
    usage: TokenUsage | None = None


class ObjectGenerationParams(BaseModel):
    """Parameters for JSON object generation."""

    prompt: str
    system: str | None = None
    temperature: float | None = Field(default=0.2, ge=0.0, le=2.0)
    max_tokens: int | None = None
    json_schema: dict[str, Any] | None = Field(default=None, alias="schema")

    model_config = {"populate_by_name": True}

    def with_system(self, system: str) -> ObjectGenerationParams:
        """Set the system prompt."""
        return self.model_copy(update={"system": system})

    def with_json_schema(self, json_schema: dict[str, Any]) -> ObjectGenerationParams:
        """Set a JSON schema."""
        return self.model_copy(update={"json_schema": json_schema})


class ObjectGenerationResponse(BaseModel):
    """Response from object generation."""

    object: dict[str, Any]
    model: str
    usage: TokenUsage | None = None


class EmbeddingParams(BaseModel):
    """Parameters for embedding generation."""

    text: str


class EmbeddingResponse(BaseModel):
    """Response from embedding generation."""

    embedding: list[float]
    model: str


class ModelInfo(BaseModel):
    """Information about an OpenRouter model."""

    id: str
    name: str
    context_length: int | None = None
    pricing: dict[str, float] | None = None


class ChatMessage(BaseModel):
    """A chat message."""

    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    """Request body for chat completions."""

    model: str
    messages: list[ChatMessage]
    temperature: float | None = None
    max_tokens: int | None = None
    top_p: float | None = None
    frequency_penalty: float | None = None
    presence_penalty: float | None = None
    stop: list[str] | None = None
    response_format: dict[str, str] | None = None

    model_config = {"populate_by_name": True}


class ChatCompletionChoice(BaseModel):
    """A choice in a chat completion response."""

    index: int
    message: ChatMessage
    finish_reason: str | None = None


class ChatCompletionResponse(BaseModel):
    """Response from chat completions."""

    id: str
    object: str
    created: int
    model: str
    choices: list[ChatCompletionChoice]
    usage: TokenUsage | None = None


class EmbeddingData(BaseModel):
    """Embedding data in response."""

    object: str
    embedding: list[float]
    index: int


class EmbeddingsRequest(BaseModel):
    """Request body for embeddings."""

    model: str
    input: str


class EmbeddingsResponse(BaseModel):
    """Response from embeddings API."""

    object: str
    data: list[EmbeddingData]
    model: str
    usage: TokenUsage | None = None
