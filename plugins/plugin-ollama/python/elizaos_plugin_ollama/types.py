from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class TextGenerationParams(BaseModel):
    prompt: str
    system: str | None = None
    temperature: float | None = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int | None = None
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)
    top_k: int | None = None
    stop: list[str] | None = None

    def with_system(self, system: str) -> TextGenerationParams:
        return self.model_copy(update={"system": system})

    def with_temperature(self, temperature: float) -> TextGenerationParams:
        return self.model_copy(update={"temperature": temperature})


class TextGenerationResponse(BaseModel):
    text: str
    model: str
    done: bool = True


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


class EmbeddingParams(BaseModel):
    text: str


class EmbeddingResponse(BaseModel):
    embedding: list[float]
    model: str


class ModelInfo(BaseModel):
    name: str
    size: int
    modified_at: str
    digest: str | None = None


class GenerateRequest(BaseModel):
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
    model: str
    prompt: str


class EmbeddingsResponse(BaseModel):
    embedding: list[float]
