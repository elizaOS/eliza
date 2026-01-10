"""
Primitive types for elizaOS.

This module defines the fundamental types used throughout elizaOS,
including UUID, Content, Media, and Metadata.
"""

from __future__ import annotations

import re
import uuid as uuid_module
from enum import Enum
from typing import Annotated, Any

from pydantic import BaseModel, BeforeValidator, Field, field_validator

# UUID validation pattern
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _coerce_uuid(value: str | uuid_module.UUID) -> str:
    """Coerce UUID objects or strings to validated UUID strings."""
    if isinstance(value, uuid_module.UUID):
        return str(value)
    if isinstance(value, str):
        if not UUID_PATTERN.match(value):
            raise ValueError(f"Invalid UUID format: {value}")
        return value
    raise TypeError(f"Expected str or UUID, got {type(value).__name__}")


# UUID type - accepts both str and uuid.UUID, stores as str
UUID = Annotated[str, BeforeValidator(_coerce_uuid)]

# The default UUID used when no room or world is specified.
# This is the nil/zero UUID (00000000-0000-0000-0000-000000000000).
# Using this allows users to spin up an AgentRuntime without worrying about room/world setup.
DEFAULT_UUID: str = "00000000-0000-0000-0000-000000000000"


def as_uuid(id_str: str | uuid_module.UUID) -> str:
    """
    Helper function to safely cast a string or UUID to a validated UUID string.

    Args:
        id_str: The string or UUID to validate and cast

    Returns:
        The validated UUID as a string

    Raises:
        ValueError: If the string is not a valid UUID format
    """
    return _coerce_uuid(id_str)


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

    This is the primary data structure for messages exchanged between
    users, agents, and the system.
    """

    thought: str | None = Field(default=None, description="The agent's internal thought process")
    text: str | None = Field(default=None, description="The main text content visible to users")
    actions: list[str] | None = Field(default=None, description="Actions to be performed")
    providers: list[str] | None = Field(
        default=None, description="Providers to use for context generation"
    )
    source: str | None = Field(
        default=None, description="Source/origin of the content (e.g., 'discord', 'telegram')"
    )
    target: str | None = Field(default=None, description="Target/destination for responses")
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
    channel_type: str | None = Field(
        default=None, alias="channelType", description="Channel type where content was sent"
    )
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
    response_id: UUID | None = Field(
        default=None,
        alias="responseId",
        description="Response ID for message tracking",
    )
    simple: bool | None = Field(
        default=None,
        description="Whether this is a simple response (no actions required)",
    )
    action_callbacks: Any | None = Field(
        default=None,
        alias="actionCallbacks",
        description="Results from action callbacks",
    )
    eval_callbacks: Any | None = Field(
        default=None,
        alias="evalCallbacks",
        description="Results from evaluator callbacks",
    )
    type: str | None = Field(default=None, description="Type marker for internal use")

    model_config = {"populate_by_name": True, "extra": "allow"}

    @field_validator("in_reply_to", "response_message_id", "response_id", mode="before")
    @classmethod
    def validate_uuid(cls, v: str | uuid_module.UUID | None) -> str | None:
        if v is None:
            return None
        return _coerce_uuid(v)


# Metadata is a generic type for metadata objects, allowing for arbitrary key-value pairs
Metadata = dict[str, Any]
