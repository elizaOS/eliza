"""Type definitions for the Copilot Proxy plugin."""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class ChatRole(str, Enum):
    """Chat message roles."""

    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"


class ChatMessage(BaseModel):
    """OpenAI-compatible chat message."""

    role: Literal["system", "user", "assistant"] = Field(..., description="Message role")
    content: str | None = Field(default=None, description="Message content")

    @classmethod
    def system(cls, content: str) -> ChatMessage:
        """Create a system message."""
        return cls(role="system", content=content)

    @classmethod
    def user(cls, content: str) -> ChatMessage:
        """Create a user message."""
        return cls(role="user", content=content)

    @classmethod
    def assistant(cls, content: str) -> ChatMessage:
        """Create an assistant message."""
        return cls(role="assistant", content=content)


class ChatCompletionRequest(BaseModel):
    """OpenAI-compatible chat completion request."""

    model: str = Field(..., description="The model to use")
    messages: list[ChatMessage] = Field(..., description="The messages to complete")
    max_tokens: int | None = Field(default=None, description="Maximum tokens to generate")
    temperature: float | None = Field(default=None, ge=0.0, le=2.0, description="Temperature")
    top_p: float | None = Field(default=None, ge=0.0, le=1.0, description="Top-p sampling")
    frequency_penalty: float | None = Field(
        default=None, ge=-2.0, le=2.0, description="Frequency penalty"
    )
    presence_penalty: float | None = Field(
        default=None, ge=-2.0, le=2.0, description="Presence penalty"
    )
    stop: list[str] | None = Field(default=None, description="Stop sequences")
    stream: bool = Field(default=False, description="Whether to stream the response")


class TokenUsage(BaseModel):
    """Token usage statistics."""

    prompt_tokens: int = Field(..., ge=0, description="Tokens in the prompt")
    completion_tokens: int = Field(default=0, ge=0, description="Tokens in the completion")
    total_tokens: int = Field(..., ge=0, description="Total tokens used")


class ChatCompletionChoice(BaseModel):
    """A chat completion choice."""

    index: int = Field(..., ge=0, description="Choice index")
    message: ChatMessage = Field(..., description="The generated message")
    finish_reason: str | None = Field(default=None, description="Finish reason")


class ChatCompletionResponse(BaseModel):
    """OpenAI-compatible chat completion response."""

    id: str = Field(..., description="Completion ID")
    object: Literal["chat.completion"] = "chat.completion"
    created: int = Field(..., description="Creation timestamp")
    model: str = Field(..., description="The model used")
    choices: list[ChatCompletionChoice] = Field(..., description="Completion choices")
    usage: TokenUsage | None = Field(default=None, description="Token usage")


class TextGenerationParams(BaseModel):
    """Parameters for text generation."""

    prompt: str = Field(..., min_length=1, description="The prompt")
    system: str | None = Field(default=None, description="System message")
    model: str | None = Field(default=None, description="Model override")
    temperature: float | None = Field(default=None, ge=0.0, le=2.0, description="Temperature")
    max_tokens: int | None = Field(default=None, ge=1, description="Maximum tokens")
    frequency_penalty: float | None = Field(
        default=None, ge=-2.0, le=2.0, description="Frequency penalty"
    )
    presence_penalty: float | None = Field(
        default=None, ge=-2.0, le=2.0, description="Presence penalty"
    )
    stop: list[str] | None = Field(default=None, description="Stop sequences")


class TextGenerationResult(BaseModel):
    """Result of text generation."""

    text: str = Field(..., description="Generated text")
    usage: TokenUsage | None = Field(default=None, description="Token usage")


class ModelInfo(BaseModel):
    """Model information."""

    id: str = Field(..., description="Model ID")
    object: Literal["model"] = "model"
    created: int = Field(..., description="Creation timestamp")
    owned_by: str = Field(..., description="Owner")


class ModelsResponse(BaseModel):
    """Response from listing models."""

    object: Literal["list"] = "list"
    data: list[ModelInfo] = Field(..., description="List of models")
