"""
Primitive types for elizaOS.

This module defines the fundamental types used throughout elizaOS,
including UUID, Content, Media, and Metadata.
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Any, NewType

from pydantic import BaseModel, Field, field_validator

# UUID type - a strongly typed string representing a universally unique identifier
UUID = NewType("UUID", str)

# UUID validation pattern
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def as_uuid(id_str: str) -> UUID:
    """
    Helper function to safely cast a string to a strongly typed UUID.

    Args:
        id_str: The string UUID to validate and cast

    Returns:
        The same UUID with branded type information

    Raises:
        ValueError: If the string is not a valid UUID format
    """
    if not id_str or not UUID_PATTERN.match(id_str):
        raise ValueError(f"Invalid UUID format: {id_str}")
    return UUID(id_str)


class ContentType(str, Enum):
    """Content type enumeration for media attachments."""

    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"
    DOCUMENT = "document"
    LINK = "link"


class Media(BaseModel):
    """Represents a media attachment."""

    id: str = Field(..., description="Unique identifier")
    url: str = Field(..., description="Media URL")
    title: str | None = Field(default=None, description="Media title")
    source: str | None = Field(default=None, description="Media source")
    description: str | None = Field(default=None, description="Media description")
    text: str | None = Field(default=None, description="Text content")
    content_type: ContentType | None = Field(
        default=None, alias="contentType", description="Content type"
    )

    model_config = {"populate_by_name": True, "extra": "allow"}


class MentionContext(BaseModel):
    """
    Platform-provided metadata about mentions.
    Contains ONLY technical facts from the platform API.
    """

    is_mention: bool = Field(
        default=False, alias="isMention", description="Platform native mention"
    )
    is_reply: bool = Field(default=False, alias="isReply", description="Reply to agent's message")
    is_thread: bool = Field(default=False, alias="isThread", description="In a thread with agent")
    mention_type: str | None = Field(
        default=None,
        alias="mentionType",
        description="Platform-specific mention type for debugging/logging",
    )

    model_config = {"populate_by_name": True}


class Content(BaseModel):
    """
    Represents the content of a memory, message, or other information.
    """

    thought: str | None = Field(default=None, description="The agent's internal thought process")
    text: str | None = Field(default=None, description="The main text content visible to users")
    actions: list[str] | None = Field(default=None, description="Optional actions to be performed")
    providers: list[str] | None = Field(
        default=None, description="Optional providers to use for context generation"
    )
    source: str | None = Field(default=None, description="Optional source/origin of the content")
    target: str | None = Field(
        default=None, description="Optional target/destination for responses"
    )
    url: str | None = Field(
        default=None,
        description="URL of the original message/post (e.g. tweet URL, Discord message link)",
    )
    in_reply_to: UUID | None = Field(
        default=None,
        alias="inReplyTo",
        description="UUID of parent message if this is a reply/thread",
    )
    attachments: list[Media] | None = Field(default=None, description="Array of media attachments")
    channel_type: str | None = Field(default=None, alias="channelType", description="Room type")
    mention_context: MentionContext | None = Field(
        default=None,
        alias="mentionContext",
        description="Platform-provided metadata about mentions",
    )
    response_message_id: UUID | None = Field(
        default=None,
        alias="responseMessageId",
        description="Internal message ID used for streaming coordination",
    )

    model_config = {"populate_by_name": True, "extra": "allow"}

    @field_validator("in_reply_to", "response_message_id", mode="before")
    @classmethod
    def validate_uuid(cls, v: str | None) -> UUID | None:
        if v is None:
            return None
        return as_uuid(v)


# Metadata is a generic type for metadata objects, allowing for arbitrary key-value pairs
Metadata = dict[str, Any]
