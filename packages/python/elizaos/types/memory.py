from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field

from elizaos.types.primitives import UUID, Content


class MemoryType(str, Enum):
    DOCUMENT = "document"
    FRAGMENT = "fragment"
    MESSAGE = "message"
    DESCRIPTION = "description"
    CUSTOM = "custom"


# Memory scope type
MemoryScope = Literal["shared", "private", "room"]


class BaseMetadata(BaseModel):
    type: str = Field(..., description="The kind of memory")
    source: str | None = Field(
        default=None, description="Optional string indicating the origin of the memory"
    )
    source_id: UUID | None = Field(
        default=None,
        alias="sourceId",
        description="Optional UUID linking to a source entity or object",
    )
    scope: MemoryScope | None = Field(
        default=None, description="The visibility scope of the memory"
    )
    timestamp: int | None = Field(
        default=None,
        description="Optional numerical timestamp of when the memory was created",
    )
    tags: list[str] | None = Field(
        default=None, description="Optional array of strings for categorizing memories"
    )

    model_config = {"populate_by_name": True, "extra": "allow"}


class DocumentMetadata(BaseMetadata):
    type: Literal[MemoryType.DOCUMENT] = MemoryType.DOCUMENT


class FragmentMetadata(BaseMetadata):
    type: Literal[MemoryType.FRAGMENT] = MemoryType.FRAGMENT
    document_id: UUID = Field(..., alias="documentId", description="ID of the parent document")
    position: int = Field(..., description="Position in the document")


class MessageMetadata(BaseMetadata):
    type: Literal[MemoryType.MESSAGE] = MemoryType.MESSAGE


class DescriptionMetadata(BaseMetadata):
    type: Literal[MemoryType.DESCRIPTION] = MemoryType.DESCRIPTION


class CustomMetadata(BaseMetadata):
    model_config = {"extra": "allow"}


# Union type for all memory metadata types
MemoryMetadata = (
    DocumentMetadata | FragmentMetadata | MessageMetadata | DescriptionMetadata | CustomMetadata
)


class Memory(BaseModel):
    id: UUID | None = Field(default=None, description="Optional unique identifier")
    entity_id: UUID = Field(..., alias="entityId", description="Associated user ID")
    agent_id: UUID | None = Field(default=None, alias="agentId", description="Associated agent ID")
    created_at: int | None = Field(
        default=None,
        alias="createdAt",
        description="Optional creation timestamp in milliseconds since epoch",
    )
    content: Content = Field(..., description="Memory content")
    embedding: list[float] | None = Field(
        default=None, description="Optional embedding vector for semantic search"
    )
    room_id: UUID = Field(..., alias="roomId", description="Associated room ID")
    world_id: UUID | None = Field(
        default=None, alias="worldId", description="Associated world ID (optional)"
    )
    unique: bool | None = Field(
        default=None,
        description="Whether memory is unique (used to prevent duplicates)",
    )
    similarity: float | None = Field(
        default=None,
        description="Embedding similarity score (set when retrieved via search)",
    )
    metadata: MemoryMetadata | None = Field(default=None, description="Metadata for the memory")

    model_config = {"populate_by_name": True, "extra": "allow"}


class MessageMemory(Memory):
    metadata: MessageMetadata = Field(..., description="Message metadata")
    content: Content = Field(..., description="Content with required text")

    def __init__(self, **data: Any) -> None:
        super().__init__(**data)
        if not self.content.text:
            raise ValueError("MessageMemory must have text content")
