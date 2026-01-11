"""
Core types for the Anthropic API.

All types use Pydantic for strong validation and type safety.
No Optional types for required fields - fail fast on missing data.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class Role(str, Enum):
    """Message role in a conversation."""

    USER = "user"
    ASSISTANT = "assistant"


class StopReason(str, Enum):
    """Reason generation stopped."""

    END_TURN = "end_turn"
    STOP_SEQUENCE = "stop_sequence"
    MAX_TOKENS = "max_tokens"
    TOOL_USE = "tool_use"


class ContentBlock(BaseModel):
    """Content block in a message."""

    type: str

    @classmethod
    def create_text(cls, content: str) -> TextContentBlock:
        """Create a text content block."""
        return TextContentBlock(type="text", text_content=content)

    def get_text(self) -> str | None:
        """Get text content if this is a text block."""
        if isinstance(self, TextContentBlock):
            return self.text_content
        return None


class TextContentBlock(ContentBlock):
    """Text content block."""

    type: str = "text"
    text_content: str


class ThinkingContentBlock(ContentBlock):
    """Thinking content block for chain-of-thought."""

    type: str = "thinking"
    thinking: str


class ImageSource(BaseModel):
    """Image source for image content blocks."""

    type: str = "base64"
    media_type: str
    data: str


class ImageContentBlock(ContentBlock):
    """Image content block."""

    type: str = "image"
    source: ImageSource


class ToolUseContentBlock(ContentBlock):
    """Tool use request from Claude."""

    type: str = "tool_use"
    id: str
    name: str
    input: dict[str, Any]


class ToolResultContentBlock(ContentBlock):
    """Tool result from user."""

    type: str = "tool_result"
    tool_use_id: str
    content: str


class Message(BaseModel):
    """A message in a conversation."""

    role: Role
    content: list[ContentBlock]

    @classmethod
    def user(cls, text: str) -> Message:
        """Create a user message with text content."""
        return cls(role=Role.USER, content=[ContentBlock.create_text(text)])

    @classmethod
    def assistant(cls, text: str) -> Message:
        """Create an assistant message with text content."""
        return cls(role=Role.ASSISTANT, content=[ContentBlock.create_text(text)])

    def text_content(self) -> str:
        """Get all text content from this message."""
        return "".join(
            block.get_text() or "" for block in self.content if block.get_text() is not None
        )


class TokenUsage(BaseModel):
    """Token usage information from API response."""

    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0

    def total_tokens(self) -> int:
        """Get total tokens used."""
        return self.input_tokens + self.output_tokens


class TextGenerationParams(BaseModel):
    """Parameters for text generation."""

    prompt: str
    system: str | None = None
    messages: list[Message] | None = None
    max_tokens: int | None = None
    temperature: float | None = None
    top_p: float | None = None
    stop_sequences: list[str] | None = None
    thinking_budget: int | None = None

    def with_system(self, system: str) -> TextGenerationParams:
        """Set the system prompt."""
        return self.model_copy(update={"system": system})

    def with_max_tokens(self, max_tokens: int) -> TextGenerationParams:
        """Set max tokens."""
        return self.model_copy(update={"max_tokens": max_tokens})

    def with_temperature(self, temperature: float) -> TextGenerationParams:
        """Set temperature (clears top_p since they're mutually exclusive)."""
        return self.model_copy(update={"temperature": temperature, "top_p": None})

    def with_top_p(self, top_p: float) -> TextGenerationParams:
        """Set top_p (clears temperature since they're mutually exclusive)."""
        return self.model_copy(update={"top_p": top_p, "temperature": None})


class TextGenerationResponse(BaseModel):
    """Response from text generation."""

    text: str
    thinking: str | None = None
    usage: TokenUsage
    stop_reason: StopReason
    model: str


class ObjectGenerationParams(BaseModel):
    """Parameters for JSON object generation."""

    prompt: str
    system: str | None = None
    json_schema: dict[str, Any] | None = None
    temperature: float | None = Field(default=0.2)  # Lower default for structured output
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


class MessagesRequest(BaseModel):
    """Request body for the Anthropic messages API."""

    model: str
    max_tokens: int
    messages: list[Message]
    system: str | None = None
    temperature: float | None = None
    top_p: float | None = None
    stop_sequences: list[str] | None = None
    metadata: dict[str, str] | None = None

    class Config:
        """Pydantic config."""

        populate_by_name = True


class MessagesResponse(BaseModel):
    """Response body from the Anthropic messages API."""

    id: str
    type: str
    role: Role
    content: list[dict[str, Any]]  # Raw content blocks
    model: str
    stop_reason: StopReason | None = None
    usage: TokenUsage

    def get_text_blocks(self) -> list[str]:
        """Extract text from content blocks."""
        texts: list[str] = []
        for block in self.content:
            if block.get("type") == "text":
                text = block.get("text")
                if isinstance(text, str):
                    texts.append(text)
        return texts

    def get_thinking_blocks(self) -> list[str]:
        """Extract thinking from content blocks."""
        thinking: list[str] = []
        for block in self.content:
            if block.get("type") == "thinking":
                text = block.get("thinking")
                if isinstance(text, str):
                    thinking.append(text)
        return thinking


class ErrorDetail(BaseModel):
    """Error detail from the Anthropic API."""

    type: str
    message: str


class ErrorResponse(BaseModel):
    """Error response from the Anthropic API."""

    type: str
    error: ErrorDetail
