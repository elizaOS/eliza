"""Message with content blocks, matching Anthropic Messages API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from .content import ContentBlock, TextBlock


class Message(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: list[ContentBlock] = Field(default_factory=list)
    reasoning_content: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _coerce_str_content(cls, values: dict) -> dict:
        """Allow constructing with content='string' for convenience."""
        c = values.get("content")
        if isinstance(c, str):
            values["content"] = [TextBlock(text=c).model_dump()]
        return values

    @property
    def text(self) -> str:
        """Concatenate all TextBlock content."""
        return "\n".join(b.text for b in self.content if hasattr(b, "text") and b.type == "text")
