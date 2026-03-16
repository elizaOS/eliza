from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class TokenUsage(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int

    def total(self) -> int:
        return self.total_tokens


class TextGenerationParams(BaseModel):
    prompt: str
    system: str | None = None
    temperature: float | None = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int | None = None
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)
    frequency_penalty: float | None = None
    presence_penalty: float | None = None
    stop: list[str] | None = None

    def with_system(self, system: str) -> TextGenerationParams:
        return self.model_copy(update={"system": system})

    def with_temperature(self, temperature: float) -> TextGenerationParams:
        return self.model_copy(update={"temperature": temperature})


class TextGenerationResponse(BaseModel):
    text: str
    model: str
    usage: TokenUsage | None = None


class ObjectGenerationParams(BaseModel):
    prompt: str
    system: str | None = None
    temperature: float | None = Field(default=0.2, ge=0.0, le=2.0)
    max_tokens: int | None = None
    json_schema: dict[str, Any] | None = Field(default=None, alias="schema")

    model_config = {"populate_by_name": True}

    def with_system(self, system: str) -> ObjectGenerationParams:
        return self.model_copy(update={"system": system})

    def with_json_schema(self, json_schema: dict[str, Any]) -> ObjectGenerationParams:
        return self.model_copy(update={"json_schema": json_schema})


class ObjectGenerationResponse(BaseModel):
    object: dict[str, Any]
    model: str
    usage: TokenUsage | None = None


class EmbeddingParams(BaseModel):
    text: str


class EmbeddingResponse(BaseModel):
    embedding: list[float]
    model: str


class ModelInfo(BaseModel):
    id: str
    name: str
    context_length: int | None = None
    pricing: dict[str, float] | None = None


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
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
    index: int
    message: ChatMessage
    finish_reason: str | None = None


class ChatCompletionResponse(BaseModel):
    id: str
    object: str
    created: int
    model: str
    choices: list[ChatCompletionChoice]
    usage: TokenUsage | None = None


class EmbeddingData(BaseModel):
    object: str
    embedding: list[float]
    index: int


class EmbeddingsRequest(BaseModel):
    model: str
    input: str


class EmbeddingsResponse(BaseModel):
    object: str
    data: list[EmbeddingData]
    model: str
    usage: TokenUsage | None = None
