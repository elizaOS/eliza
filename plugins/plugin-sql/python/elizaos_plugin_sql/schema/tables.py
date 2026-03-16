"""
SQLAlchemy table definitions for elizaOS.

These tables mirror the TypeScript Drizzle schema for compatibility.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import DeclarativeBase, relationship


def _utc_now() -> datetime:
    """Return current UTC time as timezone-aware datetime."""
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class AgentTable(Base):
    __tablename__ = "agents"

    id = Column(UUID(as_uuid=True), primary_key=True)
    name = Column(String(255), nullable=False)
    username = Column(String(255), nullable=True)
    bio = Column(Text, nullable=True)
    system = Column(Text, nullable=True)
    settings = Column(JSON, nullable=True)
    secrets = Column(JSON, nullable=True)
    enabled = Column(Boolean, default=True)
    status = Column(String(50), default="active")
    created_at = Column(DateTime(timezone=True), default=_utc_now, nullable=False)
    updated_at = Column(
        DateTime(timezone=True), default=_utc_now, onupdate=_utc_now, nullable=False
    )

    # Relationships
    entities = relationship("EntityTable", back_populates="agent")
    rooms = relationship("RoomTable", back_populates="agent")
    worlds = relationship("WorldTable", back_populates="agent")

    __table_args__ = (Index("idx_agents_name", "name"),)


class EntityTable(Base):
    __tablename__ = "entities"

    id = Column(UUID(as_uuid=True), primary_key=True)
    agent_id = Column(
        UUID(as_uuid=True), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False
    )
    names: Column[list[str]] = Column(ARRAY(String), nullable=False)
    entity_metadata = Column("metadata", JSON, default={})
    created_at = Column(DateTime(timezone=True), default=_utc_now, nullable=False)
    updated_at = Column(
        DateTime(timezone=True), default=_utc_now, onupdate=_utc_now, nullable=False
    )

    # Relationships
    agent = relationship("AgentTable", back_populates="entities")
    components = relationship("ComponentTable", back_populates="entity")
    participations = relationship("ParticipantTable", back_populates="entity")

    __table_args__ = (Index("idx_entities_agent_id", "agent_id"),)


class ComponentTable(Base):
    __tablename__ = "components"

    id = Column(UUID(as_uuid=True), primary_key=True)
    entity_id = Column(
        UUID(as_uuid=True), ForeignKey("entities.id", ondelete="CASCADE"), nullable=False
    )
    agent_id = Column(UUID(as_uuid=True), nullable=False)
    room_id = Column(UUID(as_uuid=True), nullable=False)
    world_id = Column(UUID(as_uuid=True), nullable=False)
    source_entity_id = Column(UUID(as_uuid=True), nullable=False)
    type = Column(String(255), nullable=False)
    data = Column(JSON, default={})
    created_at = Column(DateTime(timezone=True), default=_utc_now, nullable=False)

    # Relationships
    entity = relationship("EntityTable", back_populates="components")

    __table_args__ = (
        Index("idx_components_entity_id", "entity_id"),
        Index("idx_components_type", "type"),
    )


class WorldTable(Base):
    __tablename__ = "worlds"

    id = Column(UUID(as_uuid=True), primary_key=True)
    name = Column(String(255), nullable=True)
    agent_id = Column(
        UUID(as_uuid=True), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False
    )
    message_server_id = Column(UUID(as_uuid=True), nullable=True)
    world_metadata = Column("metadata", JSON, default={})
    created_at = Column(DateTime(timezone=True), default=_utc_now, nullable=False)
    updated_at = Column(
        DateTime(timezone=True), default=_utc_now, onupdate=_utc_now, nullable=False
    )

    # Relationships
    agent = relationship("AgentTable", back_populates="worlds")
    rooms = relationship("RoomTable", back_populates="world")

    __table_args__ = (Index("idx_worlds_agent_id", "agent_id"),)


class RoomTable(Base):
    __tablename__ = "rooms"

    id = Column(UUID(as_uuid=True), primary_key=True)
    name = Column(String(255), nullable=True)
    agent_id = Column(
        UUID(as_uuid=True), ForeignKey("agents.id", ondelete="CASCADE"), nullable=True
    )
    source = Column(String(100), nullable=False)
    type = Column(String(50), nullable=False)
    channel_id = Column(String(255), nullable=True)
    message_server_id = Column(UUID(as_uuid=True), nullable=True)
    world_id = Column(
        UUID(as_uuid=True), ForeignKey("worlds.id", ondelete="SET NULL"), nullable=True
    )
    room_metadata = Column("metadata", JSON, default={})
    created_at = Column(DateTime(timezone=True), default=_utc_now, nullable=False)
    updated_at = Column(
        DateTime(timezone=True), default=_utc_now, onupdate=_utc_now, nullable=False
    )

    # Relationships
    agent = relationship("AgentTable", back_populates="rooms")
    world = relationship("WorldTable", back_populates="rooms")
    participants = relationship("ParticipantTable", back_populates="room")
    memories = relationship("MemoryTable", back_populates="room")

    __table_args__ = (
        Index("idx_rooms_agent_id", "agent_id"),
        Index("idx_rooms_world_id", "world_id"),
        Index("idx_rooms_source", "source"),
    )


class ParticipantTable(Base):
    __tablename__ = "participants"

    id = Column(UUID(as_uuid=True), primary_key=True)
    entity_id = Column(
        UUID(as_uuid=True), ForeignKey("entities.id", ondelete="CASCADE"), nullable=False
    )
    room_id = Column(UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False)
    user_state = Column(String(50), nullable=True)
    created_at = Column(DateTime(timezone=True), default=_utc_now, nullable=False)

    # Relationships
    entity = relationship("EntityTable", back_populates="participations")
    room = relationship("RoomTable", back_populates="participants")

    __table_args__ = (
        UniqueConstraint("entity_id", "room_id", name="uq_participant_entity_room"),
        Index("idx_participants_entity_id", "entity_id"),
        Index("idx_participants_room_id", "room_id"),
    )


class MemoryTable(Base):
    __tablename__ = "memories"

    id = Column(UUID(as_uuid=True), primary_key=True)
    entity_id = Column(UUID(as_uuid=True), nullable=False)
    agent_id = Column(UUID(as_uuid=True), nullable=True)
    room_id = Column(UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False)
    world_id = Column(UUID(as_uuid=True), nullable=True)
    content = Column(JSON, nullable=False)
    unique = Column(Boolean, default=False)
    memory_metadata = Column("metadata", JSON, default={})
    created_at = Column(DateTime(timezone=True), default=_utc_now, nullable=False)

    # Relationships
    room = relationship("RoomTable", back_populates="memories")
    embedding = relationship("EmbeddingTable", back_populates="memory", uselist=False)

    __table_args__ = (
        Index("idx_memories_room_id", "room_id"),
        Index("idx_memories_entity_id", "entity_id"),
        Index("idx_memories_agent_id", "agent_id"),
        Index("idx_memories_created_at", "created_at"),
    )


class EmbeddingTable(Base):
    __tablename__ = "embeddings"

    id = Column(UUID(as_uuid=True), primary_key=True)
    memory_id = Column(
        UUID(as_uuid=True),
        ForeignKey("memories.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    # Vector stored as ARRAY of floats for compatibility
    # For production, use pgvector extension
    embedding_vector: Column[list[float]] = Column("embedding", ARRAY(Float), nullable=False)
    dimension = Column(Integer, nullable=False)
    created_at = Column(DateTime(timezone=True), default=_utc_now, nullable=False)

    # Relationships
    memory = relationship("MemoryTable", back_populates="embedding")

    __table_args__ = (Index("idx_embeddings_memory_id", "memory_id"),)


class RelationshipTable(Base):
    __tablename__ = "relationships"

    id = Column(UUID(as_uuid=True), primary_key=True)
    source_entity_id = Column(UUID(as_uuid=True), nullable=False)
    target_entity_id = Column(UUID(as_uuid=True), nullable=False)
    agent_id = Column(UUID(as_uuid=True), nullable=False)
    tags: Column[list[str]] = Column(ARRAY(String), default=[])
    relationship_metadata = Column("metadata", JSON, default={})
    created_at = Column(DateTime(timezone=True), default=_utc_now, nullable=False)

    __table_args__ = (
        Index("idx_relationships_source", "source_entity_id"),
        Index("idx_relationships_target", "target_entity_id"),
        Index("idx_relationships_agent", "agent_id"),
    )


class TaskTable(Base):
    __tablename__ = "tasks"

    id = Column(UUID(as_uuid=True), primary_key=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    room_id = Column(UUID(as_uuid=True), nullable=True)
    entity_id = Column(UUID(as_uuid=True), nullable=True)
    world_id = Column(UUID(as_uuid=True), nullable=True)
    status = Column(String(50), default="pending", nullable=False)
    task_tags: Column[list[str]] = Column("tags", ARRAY(String), default=[])
    task_metadata = Column("metadata", JSON, default={})
    created_at = Column(DateTime(timezone=True), default=_utc_now, nullable=False)
    updated_at = Column(
        DateTime(timezone=True), default=_utc_now, onupdate=_utc_now, nullable=False
    )

    __table_args__ = (
        Index("idx_tasks_name", "name"),
        Index("idx_tasks_status", "status"),
        Index("idx_tasks_room_id", "room_id"),
    )


class CacheTable(Base):
    __tablename__ = "cache"

    key = Column(String(512), primary_key=True)
    value = Column(JSON, nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=_utc_now, nullable=False)

    __table_args__ = (Index("idx_cache_expires_at", "expires_at"),)


class LogTable(Base):
    __tablename__ = "logs"

    id = Column(UUID(as_uuid=True), primary_key=True)
    entity_id = Column(UUID(as_uuid=True), nullable=False)
    room_id = Column(UUID(as_uuid=True), nullable=True)
    type = Column(String(100), nullable=False)
    body = Column(JSON, nullable=False)
    created_at = Column(DateTime(timezone=True), default=_utc_now, nullable=False)

    __table_args__ = (
        Index("idx_logs_entity_id", "entity_id"),
        Index("idx_logs_room_id", "room_id"),
        Index("idx_logs_type", "type"),
        Index("idx_logs_created_at", "created_at"),
    )
