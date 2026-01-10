"""
Core types for the Ollama API.

All types use Pydantic for strong validation and type safety.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class TextGenerationParams(BaseModel):
    """Parameters for text generation."""

    prompt: str
    system: str | None = None
    temperature: float | None = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int | None = None
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)
    top_k: int | None = None
    stop: list[str] | None = None

    def with_system(self, system: str) -> "TextGenerationParams":
        """Set the system prompt."""
        return self.model_copy(update={"system": system})

    def with_temperature(self, temperature: float) -> "TextGenerationParams":
        """Set temperature."""
        return self.model_copy(update={"temperature": temperature})


class TextGenerationResponse(BaseModel):
    """Response from text generation."""

    text: str
    model: str
    done: bool = True


class ObjectGenerationParams(BaseModel):
    """Parameters for JSON object generation."""

    prompt: str
    system: str | None = None
    temperature: float | None = Field(default=0.2, ge=0.0, le=2.0)
    max_tokens: int | None = None
    json_schema: dict[str, Any] | None = Field(default=None, alias="schema")

    model_config = {"populate_by_name": True}

    def with_system(self, system: str) -> "ObjectGenerationParams":
        """Set the system prompt."""
        return self.model_copy(update={"system": system})

    def with_json_schema(self, json_schema: dict[str, Any]) -> "ObjectGenerationParams":
        """Set a JSON schema."""
        return self.model_copy(update={"json_schema": json_schema})


class ObjectGenerationResponse(BaseModel):
    """Response from object generation."""

    object: dict[str, Any]
    model: str


class EmbeddingParams(BaseModel):
    """Parameters for embedding generation."""

    text: str


class EmbeddingResponse(BaseModel):
    """Response from embedding generation."""

    embedding: list[float]
    model: str


class ModelInfo(BaseModel):
    """Information about an Ollama model."""

    name: str
    size: int
    modified_at: str
    digest: str | None = None


class GenerateRequest(BaseModel):
    """Request body for the Ollama generate API."""

    model: str
    prompt: str
    system: str | None = None
    template: str | None = None
    context: list[int] | None = None
    stream: bool = False
    raw: bool = False
    format: str | None = None
    options: dict[str, Any] | None = None


class GenerateResponse(BaseModel):
    """Response body from the Ollama generate API."""

    model: str
    created_at: str
    response: str
    done: bool
    context: list[int] | None = None
    total_duration: int | None = None
    load_duration: int | None = None
    prompt_eval_count: int | None = None
    prompt_eval_duration: int | None = None
    eval_count: int | None = None
    eval_duration: int | None = None


class EmbeddingsRequest(BaseModel):
    """Request body for the Ollama embeddings API."""

    model: str
    prompt: str


class EmbeddingsResponse(BaseModel):
    """Response body from the Ollama embeddings API."""

    embedding: list[float]

