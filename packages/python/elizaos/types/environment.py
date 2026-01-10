"""
Environment types for elizaOS.

This module defines types for entities, rooms, worlds, and their relationships.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field

from elizaos.types.primitives import UUID, Metadata


class Component(BaseModel):
    """Component attached to an entity."""

    id: UUID = Field(..., description="Unique identifier")
    entity_id: UUID = Field(..., alias="entityId", description="Entity this belongs to")
    agent_id: UUID = Field(..., alias="agentId", description="Associated agent")
    room_id: UUID = Field(..., alias="roomId", description="Associated room")
    world_id: UUID = Field(..., alias="worldId", description="Associated world")
    source_entity_id: UUID = Field(..., alias="sourceEntityId", description="Source entity")
    type: str = Field(..., description="Component type")
    created_at: int = Field(..., alias="createdAt", description="Creation timestamp")
    data: Metadata = Field(..., description="Component data")

    model_config = {"populate_by_name": True}


class Entity(BaseModel):
    """Represents a user account or entity."""

    id: UUID | None = Field(default=None, description="Unique identifier, optional on creation")
    names: list[str] = Field(..., description="Names of the entity")
    metadata: Metadata = Field(default_factory=dict, description="Additional metadata")
    agent_id: UUID = Field(
        ...,
        alias="agentId",
        description="Agent ID this account is related to",
    )
    components: list[Component] | None = Field(
        default=None, description="Optional array of components"
    )

    model_config = {"populate_by_name": True}


class Role(str, Enum):
    """Defines roles within a system, typically for access control."""

    OWNER = "OWNER"
    ADMIN = "ADMIN"
    NONE = "NONE"


class WorldMetadata(BaseModel):
    """Metadata for a world."""

    ownership: dict[str, str] | None = Field(default=None, description="Ownership information")
    roles: dict[UUID, Role] | None = Field(
        default=None, description="Role assignments by entity ID"
    )

    model_config = {"extra": "allow"}


class World(BaseModel):
    """
    Represents a world - a collection of rooms and entities
    (e.g., a Discord server, a project).
    """

    id: UUID = Field(..., description="Unique identifier")
    name: str | None = Field(default=None, description="World name")
    agent_id: UUID = Field(..., alias="agentId", description="Associated agent")
    message_server_id: UUID | None = Field(
        default=None, alias="messageServerId", description="Message server ID"
    )
    metadata: WorldMetadata | None = Field(default=None, description="World metadata")

    model_config = {"populate_by_name": True}


class ChannelType(str, Enum):
    """Channel type enumeration."""

    SELF = "SELF"  # Messages to self
    DM = "DM"  # Direct messages between two participants
    GROUP = "GROUP"  # Group messages with multiple participants
    VOICE_DM = "VOICE_DM"  # Voice direct messages
    VOICE_GROUP = "VOICE_GROUP"  # Voice channels with multiple participants
    FEED = "FEED"  # Social media feed
    THREAD = "THREAD"  # Threaded conversation
    WORLD = "WORLD"  # World channel
    FORUM = "FORUM"  # Forum discussion
    API = "API"  # API-initiated messages


class RoomMetadata(BaseModel):
    """Metadata for a room."""

    model_config = {"extra": "allow"}


class Room(BaseModel):
    """Represents a room - a specific context for interaction."""

    id: UUID = Field(..., description="Unique identifier")
    name: str | None = Field(default=None, description="Room name")
    agent_id: UUID | None = Field(default=None, alias="agentId", description="Associated agent")
    source: str = Field(..., description="Source platform (e.g., 'discord', 'cli')")
    type: ChannelType = Field(..., description="Channel type")
    channel_id: str | None = Field(
        default=None, alias="channelId", description="Platform channel ID"
    )
    message_server_id: UUID | None = Field(
        default=None, alias="messageServerId", description="Message server ID"
    )
    world_id: UUID | None = Field(default=None, alias="worldId", description="Associated world")
    metadata: Metadata | None = Field(default=None, description="Room metadata")

    model_config = {"populate_by_name": True}


class Participant(BaseModel):
    """Room participant with account details."""

    id: UUID = Field(..., description="Unique identifier")
    entity: Entity = Field(..., description="Associated account")

    model_config = {"populate_by_name": True}


class Relationship(BaseModel):
    """Represents a relationship between users."""

    id: UUID = Field(..., description="Unique identifier")
    source_entity_id: UUID = Field(..., alias="sourceEntityId", description="First user ID")
    target_entity_id: UUID = Field(..., alias="targetEntityId", description="Second user ID")
    agent_id: UUID = Field(..., alias="agentId", description="Agent ID")
    tags: list[str] = Field(default_factory=list, description="Tags for filtering/categorizing")
    metadata: Metadata = Field(default_factory=dict, description="Additional metadata")
    created_at: str | None = Field(
        default=None, alias="createdAt", description="Optional creation timestamp"
    )

    model_config = {"populate_by_name": True}





