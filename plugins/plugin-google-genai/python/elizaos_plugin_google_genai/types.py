"""
Core types for the Google GenAI API.

All types use Pydantic for strong validation and type safety.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ContentBlock(BaseModel):
    """Content block in a message."""

    type: str

    @classmethod
    def create_text(cls, content: str) -> TextContentBlock:
        """Create a text content block."""
        return TextContentBlock(type="text", text_content=content)


class TextContentBlock(ContentBlock):
    """Text content block."""

    type: str = "text"
    text_content: str


class TokenUsage(BaseModel):
    """Token usage information from API response."""

    model_config = ConfigDict(populate_by_name=True)

    prompt_tokens: int = Field(alias="promptTokenCount", default=0)
    completion_tokens: int = Field(alias="candidatesTokenCount", default=0)
    total_tokens: int = Field(alias="totalTokenCount", default=0)


class TextGenerationParams(BaseModel):
    """Parameters for text generation."""

    prompt: str
    system: str | None = None
    max_tokens: int | None = None
    temperature: float | None = Field(default=0.7)
    top_k: int | None = Field(default=40)
    top_p: float | None = Field(default=0.95)
    stop_sequences: list[str] | None = None

    def with_system(self, system: str) -> TextGenerationParams:
        """Set the system prompt."""
        return self.model_copy(update={"system": system})

    def with_max_tokens(self, max_tokens: int) -> TextGenerationParams:
        """Set max tokens."""
        return self.model_copy(update={"max_tokens": max_tokens})

    def with_temperature(self, temperature: float) -> TextGenerationParams:
        """Set temperature."""
        return self.model_copy(update={"temperature": temperature})


class TextGenerationResponse(BaseModel):
    """Response from text generation."""

    text: str
    usage: TokenUsage
    model: str


class EmbeddingParams(BaseModel):
    """Parameters for embedding generation."""

    text: str


class EmbeddingResponse(BaseModel):
    """Response from embedding generation."""

    embedding: list[float]
    model: str


class ImageDescriptionParams(BaseModel):
    """Parameters for image description."""

    image_url: str
    prompt: str | None = None


class ImageDescriptionResponse(BaseModel):
    """Response from image description."""

    title: str
    description: str


class ObjectGenerationParams(BaseModel):
    """Parameters for JSON object generation."""

    prompt: str
    system: str | None = None
    json_schema: dict[str, Any] | None = None
    temperature: float | None = Field(default=0.1)
    max_tokens: int | None = None

    def with_system(self, system: str) -> ObjectGenerationParams:
        """Set the system prompt."""
        return self.model_copy(update={"system": system})

    def with_schema(self, json_schema: dict[str, Any]) -> ObjectGenerationParams:
        """Set a JSON schema."""
        return self.model_copy(update={"json_schema": json_schema})

    def with_temperature(self, temperature: float) -> ObjectGenerationParams:
        """Set temperature."""
        return self.model_copy(update={"temperature": temperature})


class ObjectGenerationResponse(BaseModel):
    """Response from object generation."""

    object: dict[str, Any]
    usage: TokenUsage
    model: str


class GenerateContentRequest(BaseModel):
    """Request body for the Google GenAI generateContent API."""

    model_config = ConfigDict(populate_by_name=True)

    contents: list[dict[str, Any]]
    generation_config: dict[str, Any] | None = Field(alias="generationConfig", default=None)
    safety_settings: list[dict[str, Any]] | None = Field(alias="safetySettings", default=None)
    system_instruction: dict[str, Any] | None = Field(alias="systemInstruction", default=None)


class GenerateContentResponse(BaseModel):
    """Response body from the Google GenAI generateContent API."""

    model_config = ConfigDict(populate_by_name=True)

    candidates: list[dict[str, Any]]
    usage_metadata: TokenUsage | None = Field(alias="usageMetadata", default=None)

    def get_text(self) -> str:
        """Extract text from the first candidate."""
        if not self.candidates:
            return ""
        first_candidate = self.candidates[0]
        content = first_candidate.get("content", {})
        parts = content.get("parts", [])
        texts: list[str] = []
        for part in parts:
            if isinstance(part, dict) and "text" in part:
                text = part.get("text")
                if isinstance(text, str):
                    texts.append(text)
        return "".join(texts)


class EmbedContentRequest(BaseModel):
    """Request body for the Google GenAI embedContent API."""

    model_config = ConfigDict(populate_by_name=True)

    content: dict[str, Any]


class EmbedContentResponse(BaseModel):
    """Response body from the Google GenAI embedContent API."""

    model_config = ConfigDict(populate_by_name=True)

    embedding: dict[str, Any]

    def get_values(self) -> list[float]:
        """Extract embedding values."""
        values = self.embedding.get("values", [])
        if isinstance(values, list):
            return [float(v) for v in values]
        return []


class ErrorDetail(BaseModel):
    """Error detail from the Google GenAI API."""

    code: int
    message: str
    status: str


class ErrorResponse(BaseModel):
    """Error response from the Google GenAI API."""

    error: ErrorDetail
