from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class Role(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"


class StopReason(str, Enum):
    END_TURN = "end_turn"
    STOP_SEQUENCE = "stop_sequence"
    MAX_TOKENS = "max_tokens"
    TOOL_USE = "tool_use"


class ContentBlock(BaseModel):
    type: str

    @classmethod
    def create_text(cls, content: str) -> TextContentBlock:
        return TextContentBlock(type="text", text_content=content)

    def get_text(self) -> str | None:
        if isinstance(self, TextContentBlock):
            return self.text_content
        return None


class TextContentBlock(ContentBlock):
    type: str = "text"
    text_content: str


class ThinkingContentBlock(ContentBlock):
    type: str = "thinking"
    thinking: str


class ImageSource(BaseModel):
    type: str = "base64"
    media_type: str
    data: str


class ImageContentBlock(ContentBlock):
    type: str = "image"
    source: ImageSource


class ToolUseContentBlock(ContentBlock):
    type: str = "tool_use"
    id: str
    name: str
    input: dict[str, Any]


class ToolResultContentBlock(ContentBlock):
    type: str = "tool_result"
    tool_use_id: str
    content: str


class Message(BaseModel):
    role: Role
    content: list[ContentBlock]

    @classmethod
    def user(cls, text: str) -> Message:
        return cls(role=Role.USER, content=[ContentBlock.create_text(text)])

    @classmethod
    def assistant(cls, text: str) -> Message:
        return cls(role=Role.ASSISTANT, content=[ContentBlock.create_text(text)])

    def text_content(self) -> str:
        return "".join(
            block.get_text() or "" for block in self.content if block.get_text() is not None
        )


class TokenUsage(BaseModel):
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0

    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


class TextGenerationParams(BaseModel):
    prompt: str
    system: str | None = None
    messages: list[Message] | None = None
    max_tokens: int | None = None
    temperature: float | None = None
    top_p: float | None = None
    stop_sequences: list[str] | None = None
    thinking_budget: int | None = None

    def with_system(self, system: str) -> TextGenerationParams:
        return self.model_copy(update={"system": system})

    def with_max_tokens(self, max_tokens: int) -> TextGenerationParams:
        return self.model_copy(update={"max_tokens": max_tokens})

    def with_temperature(self, temperature: float) -> TextGenerationParams:
        return self.model_copy(update={"temperature": temperature, "top_p": None})

    def with_top_p(self, top_p: float) -> TextGenerationParams:
        return self.model_copy(update={"top_p": top_p, "temperature": None})


class TextGenerationResponse(BaseModel):
    text: str
    thinking: str | None = None
    usage: TokenUsage
    stop_reason: StopReason
    model: str


class ObjectGenerationParams(BaseModel):
    prompt: str
    system: str | None = None
    json_schema: dict[str, Any] | None = None
    temperature: float | None = Field(default=0.2)
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


class MessagesRequest(BaseModel):
    model: str
    max_tokens: int
    messages: list[Message]
    system: str | None = None
    temperature: float | None = None
    top_p: float | None = None
    stop_sequences: list[str] | None = None
    metadata: dict[str, str] | None = None

    class Config:
        populate_by_name = True


class MessagesResponse(BaseModel):
    id: str
    type: str
    role: Role
    content: list[dict[str, Any]]
    model: str
    stop_reason: StopReason | None = None
    usage: TokenUsage

    def get_text_blocks(self) -> list[str]:
        texts: list[str] = []
        for block in self.content:
            if block.get("type") == "text":
                text = block.get("text")
                if isinstance(text, str):
                    texts.append(text)
        return texts

    def get_thinking_blocks(self) -> list[str]:
        thinking: list[str] = []
        for block in self.content:
            if block.get("type") == "thinking":
                text = block.get("thinking")
                if isinstance(text, str):
                    thinking.append(text)
        return thinking


class ErrorDetail(BaseModel):
    type: str
    message: str


class ErrorResponse(BaseModel):
    type: str
    error: ErrorDetail
