"""Initial schema migration

Revision ID: 0001
Revises:
Create Date: 2026-01-09

This migration creates the initial elizaOS database schema.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Create agents table
    op.create_table(
        "agents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("username", sa.String(255), nullable=True),
        sa.Column("bio", sa.Text(), nullable=True),
        sa.Column("system", sa.Text(), nullable=True),
        sa.Column("settings", postgresql.JSON(), nullable=True),
        sa.Column("secrets", postgresql.JSON(), nullable=True),
        sa.Column("enabled", sa.Boolean(), default=True),
        sa.Column("status", sa.String(50), default="active"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column(
            "updated_at", sa.DateTime(), server_default=sa.func.now(), onupdate=sa.func.now()
        ),
    )
    op.create_index("idx_agents_name", "agents", ["name"])

    # Create entities table
    op.create_table(
        "entities",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "agent_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("agents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("names", postgresql.ARRAY(sa.String()), nullable=False),
        sa.Column("metadata", postgresql.JSON(), default={}),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column(
            "updated_at", sa.DateTime(), server_default=sa.func.now(), onupdate=sa.func.now()
        ),
    )
    op.create_index("idx_entities_agent_id", "entities", ["agent_id"])

    # Create worlds table
    op.create_table(
        "worlds",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=True),
        sa.Column(
            "agent_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("agents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("message_server_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("metadata", postgresql.JSON(), default={}),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("idx_worlds_agent_id", "worlds", ["agent_id"])

    # Create rooms table
    op.create_table(
        "rooms",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=True),
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("source", sa.String(100), nullable=False),
        sa.Column("type", sa.String(50), nullable=False),
        sa.Column("channel_id", sa.String(255), nullable=True),
        sa.Column("message_server_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "world_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("worlds.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("metadata", postgresql.JSON(), default={}),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("idx_rooms_agent_id", "rooms", ["agent_id"])
    op.create_index("idx_rooms_world_id", "rooms", ["world_id"])

    # Create components table
    op.create_table(
        "components",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "entity_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("entities.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("room_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("world_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_entity_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("type", sa.String(255), nullable=False),
        sa.Column("data", postgresql.JSON(), default={}),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("idx_components_entity_id", "components", ["entity_id"])
    op.create_index("idx_components_type", "components", ["type"])

    # Create participants table
    op.create_table(
        "participants",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "entity_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("entities.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "room_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("rooms.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("user_state", sa.String(50), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("idx_participants_entity_id", "participants", ["entity_id"])
    op.create_index("idx_participants_room_id", "participants", ["room_id"])
    op.create_unique_constraint(
        "uq_participants_entity_room", "participants", ["entity_id", "room_id"]
    )

    # Create memories table
    op.create_table(
        "memories",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("entity_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("room_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("world_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("content", postgresql.JSON(), nullable=False),
        sa.Column("unique", sa.Boolean(), default=False),
        sa.Column("metadata", postgresql.JSON(), default={}),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("idx_memories_room_id", "memories", ["room_id"])
    op.create_index("idx_memories_entity_id", "memories", ["entity_id"])
    op.create_index("idx_memories_agent_id", "memories", ["agent_id"])

    # Create embeddings table
    op.create_table(
        "embeddings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "memory_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("memories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("embedding", postgresql.ARRAY(sa.Float()), nullable=False),
        sa.Column("dimension", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("idx_embeddings_memory_id", "embeddings", ["memory_id"])

    # Create relationships table
    op.create_table(
        "relationships",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "source_entity_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("entities.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "target_entity_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("entities.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tags", postgresql.ARRAY(sa.String()), default=[]),
        sa.Column("metadata", postgresql.JSON(), default={}),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("idx_relationships_source", "relationships", ["source_entity_id"])
    op.create_index("idx_relationships_target", "relationships", ["target_entity_id"])

    # Create tasks table
    op.create_table(
        "tasks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("room_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("entity_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("world_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("status", sa.String(50), default="pending"),
        sa.Column("tags", postgresql.ARRAY(sa.String()), default=[]),
        sa.Column("metadata", postgresql.JSON(), default={}),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column(
            "updated_at", sa.DateTime(), server_default=sa.func.now(), onupdate=sa.func.now()
        ),
    )
    op.create_index("idx_tasks_status", "tasks", ["status"])
    op.create_index("idx_tasks_name", "tasks", ["name"])

    # Create logs table
    op.create_table(
        "logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("entity_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("room_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("type", sa.String(100), nullable=False),
        sa.Column("body", postgresql.JSON(), default={}),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("idx_logs_entity_id", "logs", ["entity_id"])
    op.create_index("idx_logs_type", "logs", ["type"])

    # Create cache table
    op.create_table(
        "cache",
        sa.Column("key", sa.String(500), primary_key=True),
        sa.Column("value", postgresql.JSON(), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("cache")
    op.drop_table("logs")
    op.drop_table("tasks")
    op.drop_table("relationships")
    op.drop_table("embeddings")
    op.drop_table("memories")
    op.drop_table("participants")
    op.drop_table("components")
    op.drop_table("rooms")
    op.drop_table("worlds")
    op.drop_table("entities")
    op.drop_table("agents")
