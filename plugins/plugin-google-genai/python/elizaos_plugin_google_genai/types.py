from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class TokenUsage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    prompt_tokens: int = Field(alias="promptTokenCount", default=0)
    completion_tokens: int = Field(alias="candidatesTokenCount", default=0)
    total_tokens: int = Field(alias="totalTokenCount", default=0)


class TextGenerationParams(BaseModel):
    prompt: str
    system: str | None = None
    max_tokens: int | None = None
    temperature: float | None = Field(default=0.7)
    top_k: int | None = Field(default=40)
    top_p: float | None = Field(default=0.95)
    stop_sequences: list[str] | None = None

    def with_system(self, system: str) -> TextGenerationParams:
        return self.model_copy(update={"system": system})

    def with_max_tokens(self, max_tokens: int) -> TextGenerationParams:
        return self.model_copy(update={"max_tokens": max_tokens})

    def with_temperature(self, temperature: float) -> TextGenerationParams:
        return self.model_copy(update={"temperature": temperature})


class TextGenerationResponse(BaseModel):
    text: str
    usage: TokenUsage
    model: str


class EmbeddingParams(BaseModel):
    text: str


class EmbeddingResponse(BaseModel):
    embedding: list[float]
    model: str


class ImageDescriptionParams(BaseModel):
    image_url: str
    prompt: str | None = None


class ImageDescriptionResponse(BaseModel):
    title: str
    description: str


class ObjectGenerationParams(BaseModel):
    prompt: str
    system: str | None = None
    json_schema: dict[str, Any] | None = None
    temperature: float | None = Field(default=0.1)
    max_tokens: int | None = None

    def with_system(self, system: str) -> ObjectGenerationParams:
        return self.model_copy(update={"system": system})

    def with_schema(self, json_schema: dict[str, Any]) -> ObjectGenerationParams:
        return self.model_copy(update={"json_schema": json_schema})

    def with_temperature(self, temperature: float) -> ObjectGenerationParams:
        return self.model_copy(update={"temperature": temperature})


class ObjectGenerationResponse(BaseModel):
    object: dict[str, Any]
    usage: TokenUsage
    model: str


class GenerateContentRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    contents: list[dict[str, Any]]
    generation_config: dict[str, Any] | None = Field(alias="generationConfig", default=None)
    safety_settings: list[dict[str, Any]] | None = Field(alias="safetySettings", default=None)
    system_instruction: dict[str, Any] | None = Field(alias="systemInstruction", default=None)


class GenerateContentResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    candidates: list[dict[str, Any]]
    usage_metadata: TokenUsage | None = Field(alias="usageMetadata", default=None)

    def get_text(self) -> str:
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
    model_config = ConfigDict(populate_by_name=True)

    content: dict[str, Any]


class EmbedContentResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    embedding: dict[str, Any]

    def get_values(self) -> list[float]:
        values = self.embedding.get("values", [])
        if isinstance(values, list):
            return [float(v) for v in values]
        return []


class ErrorDetail(BaseModel):
    code: int
    message: str
    status: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
