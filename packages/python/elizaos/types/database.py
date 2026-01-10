"""
Database types for elizaOS.

This module defines the IDatabaseAdapter interface and related types.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field

from elizaos.types.primitives import UUID

if TYPE_CHECKING:
    from elizaos.types.memory import Memory


class BaseLogBody(BaseModel):
    """Base log body type with common properties."""

    run_id: str | UUID | None = Field(default=None, alias="runId")
    status: str | None = None
    message_id: UUID | None = Field(default=None, alias="messageId")
    room_id: UUID | None = Field(default=None, alias="roomId")
    entity_id: UUID | None = Field(default=None, alias="entityId")
    metadata: dict[str, Any] | None = None

    model_config = {"populate_by_name": True, "extra": "allow"}


class ActionLogBody(BaseLogBody):
    """Log body for action logs."""

    action: str | None = None
    action_id: UUID | str | None = Field(default=None, alias="actionId")
    message: str | None = None
    state: Any | None = None
    responses: Any | None = None
    content: dict[str, Any] | None = None
    result: dict[str, Any] | None = None
    is_legacy_return: bool | None = Field(default=None, alias="isLegacyReturn")
    prompts: list[dict[str, Any]] | None = None
    prompt_count: int | None = Field(default=None, alias="promptCount")
    plan_step: str | None = Field(default=None, alias="planStep")
    plan_thought: str | None = Field(default=None, alias="planThought")


class EvaluatorLogBody(BaseLogBody):
    """Log body for evaluator logs."""

    evaluator: str | None = None
    message: str | None = None
    state: Any | None = None


class ModelLogBody(BaseLogBody):
    """Log body for model logs."""

    model_type: str | None = Field(default=None, alias="modelType")
    model_key: str | None = Field(default=None, alias="modelKey")
    params: dict[str, Any] | None = None
    prompt: str | None = None
    system_prompt: str | None = Field(default=None, alias="systemPrompt")
    timestamp: int | None = None
    execution_time: int | None = Field(default=None, alias="executionTime")
    provider: str | None = None
    action_context: dict[str, Any] | None = Field(default=None, alias="actionContext")
    response: Any | None = None


class EmbeddingLogBody(BaseLogBody):
    """Log body for embedding logs."""

    memory_id: str | None = Field(default=None, alias="memoryId")
    duration: int | None = None


# Union type for all log body types
LogBody = BaseLogBody | ActionLogBody | EvaluatorLogBody | ModelLogBody | EmbeddingLogBody


class Log(BaseModel):
    """Represents a log entry."""

    id: UUID | None = Field(default=None, description="Optional unique identifier")
    entity_id: UUID = Field(..., alias="entityId", description="Associated entity ID")
    room_id: UUID | None = Field(default=None, alias="roomId", description="Associated room ID")
    body: LogBody = Field(..., description="Log body")
    type: str = Field(..., description="Log type")
    created_at: int = Field(..., alias="createdAt", description="Log creation timestamp")

    model_config = {"populate_by_name": True}


# Run status type
RunStatus = Literal["started", "completed", "timeout", "error"]


class AgentRunCounts(BaseModel):
    """Counts for an agent run."""

    actions: int = 0
    model_calls: int = Field(default=0, alias="modelCalls")
    errors: int = 0
    evaluators: int = 0

    model_config = {"populate_by_name": True}


class AgentRunSummary(BaseModel):
    """Summary of an agent run."""

    run_id: str = Field(..., alias="runId")
    status: RunStatus
    started_at: int | None = Field(default=None, alias="startedAt")
    ended_at: int | None = Field(default=None, alias="endedAt")
    duration_ms: int | None = Field(default=None, alias="durationMs")
    message_id: UUID | None = Field(default=None, alias="messageId")
    room_id: UUID | None = Field(default=None, alias="roomId")
    entity_id: UUID | None = Field(default=None, alias="entityId")
    metadata: dict[str, Any] | None = None
    counts: AgentRunCounts | None = None

    model_config = {"populate_by_name": True}


class AgentRunSummaryResult(BaseModel):
    """Result of agent run summary query."""

    runs: list[AgentRunSummary]
    total: int
    has_more: bool = Field(..., alias="hasMore")

    model_config = {"populate_by_name": True}


class EmbeddingSearchResult(BaseModel):
    """Result interface for embedding similarity searches."""

    embedding: list[float]
    levenshtein_score: float = Field(..., alias="levenshteinScore")

    model_config = {"populate_by_name": True}


class MemoryRetrievalOptions(BaseModel):
    """Options for memory retrieval operations."""

    room_id: UUID = Field(..., alias="roomId")
    count: int | None = None
    unique: bool | None = None
    start: int | None = None
    end: int | None = None
    agent_id: UUID | None = Field(default=None, alias="agentId")

    model_config = {"populate_by_name": True}


class MemorySearchOptions(BaseModel):
    """Options for memory search operations."""

    embedding: list[float]
    match_threshold: float | None = Field(default=None, alias="matchThreshold")
    count: int | None = None
    room_id: UUID = Field(..., alias="roomId")
    agent_id: UUID | None = Field(default=None, alias="agentId")
    unique: bool | None = None
    metadata: dict[str, Any] | None = None

    model_config = {"populate_by_name": True}


class MultiRoomMemoryOptions(BaseModel):
    """Options for multi-room memory retrieval."""

    room_ids: list[UUID] = Field(..., alias="roomIds")
    limit: int | None = None
    agent_id: UUID | None = Field(default=None, alias="agentId")

    model_config = {"populate_by_name": True}


class MemoryOptions(BaseModel):
    """Options pattern for memory operations."""

    room_id: UUID = Field(..., alias="roomId")
    limit: int | None = None
    agent_id: UUID | None = Field(default=None, alias="agentId")
    unique: bool | None = None
    start: int | None = None
    end: int | None = None

    model_config = {"populate_by_name": True}


class SearchOptions(MemoryOptions):
    """Specialized memory search options."""

    embedding: list[float]
    similarity: float | None = None

    model_config = {"populate_by_name": True}


# Database connection type - actual type depends on adapter implementation
DbConnection = Any


# Vector dimension constants
class VECTOR_DIMS:
    """Allowable vector dimensions."""

    SMALL = 384
    MEDIUM = 512
    LARGE = 768
    XL = 1024
    XXL = 1536
    XXXL = 3072


class IDatabaseAdapter(ABC):
    """Interface for database operations."""

    @property
    @abstractmethod
    def db(self) -> Any:
        """Database instance."""
        ...

    @abstractmethod
    async def initialize(self, config: dict[str, str | int | bool | None] | None = None) -> None:
        """Initialize database connection."""
        ...

    @abstractmethod
    async def init(self) -> None:
        """Initialize database connection (alias)."""
        ...

    async def run_plugin_migrations(
        self,
        plugins: list[dict[str, Any]],
        options: dict[str, bool] | None = None,
    ) -> None:
        """Run plugin schema migrations for all registered plugins.

        This is an optional method - subclasses may override to implement
        custom migration logic.
        """
        _ = plugins, options  # Optional method, default is no-op

    async def run_migrations(self, migrations_paths: list[str] | None = None) -> None:
        """Run database migrations from migration files.

        This is an optional method - subclasses may override to implement
        custom migration logic.
        """
        _ = migrations_paths  # Optional method, default is no-op

    @abstractmethod
    async def is_ready(self) -> bool:
        """Check if the database connection is ready."""
        ...

    @abstractmethod
    async def close(self) -> None:
        """Close database connection."""
        ...

    @abstractmethod
    async def get_connection(self) -> Any:
        """Get database connection."""
        ...

    async def with_entity_context(self, entity_id: UUID | None, callback: Any) -> Any:
        """Execute a callback with entity context for Entity RLS."""
        _ = entity_id  # Entity ID for RLS context, subclasses may use
        return await callback()

    # Agent methods
    @abstractmethod
    async def get_agent(self, agent_id: UUID) -> Any | None:
        """Get agent by ID."""
        ...

    @abstractmethod
    async def get_agents(self) -> list[Any]:
        """Get all agents."""
        ...

    @abstractmethod
    async def create_agent(self, agent: Any) -> bool:
        """Create a new agent."""
        ...

    @abstractmethod
    async def update_agent(self, agent_id: UUID, agent: Any) -> bool:
        """Update an agent."""
        ...

    @abstractmethod
    async def delete_agent(self, agent_id: UUID) -> bool:
        """Delete an agent."""
        ...

    @abstractmethod
    async def ensure_embedding_dimension(self, dimension: int) -> None:
        """Ensure embedding dimension is set."""
        ...

    # Entity methods
    @abstractmethod
    async def get_entities_by_ids(self, entity_ids: list[UUID]) -> list[Any] | None:
        """Get entities by IDs."""
        ...

    @abstractmethod
    async def get_entities_for_room(
        self, room_id: UUID, include_components: bool = False
    ) -> list[Any]:
        """Get entities for room."""
        ...

    @abstractmethod
    async def create_entities(self, entities: list[Any]) -> bool:
        """Create new entities."""
        ...

    @abstractmethod
    async def update_entity(self, entity: Any) -> None:
        """Update entity."""
        ...

    # Component methods
    @abstractmethod
    async def get_component(
        self,
        entity_id: UUID,
        component_type: str,
        world_id: UUID | None = None,
        source_entity_id: UUID | None = None,
    ) -> Any | None:
        """Get component by ID."""
        ...

    @abstractmethod
    async def get_components(
        self,
        entity_id: UUID,
        world_id: UUID | None = None,
        source_entity_id: UUID | None = None,
    ) -> list[Any]:
        """Get all components for an entity."""
        ...

    @abstractmethod
    async def create_component(self, component: Any) -> bool:
        """Create component."""
        ...

    @abstractmethod
    async def update_component(self, component: Any) -> None:
        """Update component."""
        ...

    @abstractmethod
    async def delete_component(self, component_id: UUID) -> None:
        """Delete component."""
        ...

    # Memory methods
    @abstractmethod
    async def get_memories(
        self,
        params: dict[str, Any],
    ) -> list[Any]:
        """Get memories matching criteria."""
        ...

    @abstractmethod
    async def get_memory_by_id(self, id: UUID) -> Any | None:
        """Get memory by ID."""
        ...

    @abstractmethod
    async def get_memories_by_ids(
        self, ids: list[UUID], table_name: str | None = None
    ) -> list[Any]:
        """Get memories by IDs."""
        ...

    @abstractmethod
    async def get_memories_by_room_ids(self, params: dict[str, Any]) -> list[Any]:
        """Get memories by room IDs."""
        ...

    @abstractmethod
    async def get_cached_embeddings(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        """Get cached embeddings."""
        ...

    @abstractmethod
    async def log(self, params: dict[str, Any]) -> None:
        """Log an entry."""
        ...

    @abstractmethod
    async def get_logs(self, params: dict[str, Any]) -> list[Log]:
        """Get logs."""
        ...

    @abstractmethod
    async def delete_log(self, log_id: UUID) -> None:
        """Delete a log."""
        ...

    async def get_agent_run_summaries(self, params: dict[str, Any]) -> AgentRunSummaryResult:
        """Get agent run summaries."""
        _ = params  # Optional method, default returns empty result
        return AgentRunSummaryResult(runs=[], total=0, hasMore=False)

    @abstractmethod
    async def search_memories(self, params: dict[str, Any]) -> list[Any]:
        """Search memories by embedding similarity."""
        ...

    @abstractmethod
    async def create_memory(self, memory: Any, table_name: str, unique: bool = False) -> UUID:
        """Create a memory."""
        ...

    @abstractmethod
    async def update_memory(self, memory: Memory | dict[str, Any]) -> bool:
        """Update a memory (accepts Memory object or dict)."""
        ...

    @abstractmethod
    async def delete_memory(self, memory_id: UUID) -> None:
        """Delete a memory."""
        ...

    @abstractmethod
    async def delete_many_memories(self, memory_ids: list[UUID]) -> None:
        """Delete multiple memories."""
        ...

    @abstractmethod
    async def delete_all_memories(self, room_id: UUID, table_name: str) -> None:
        """Delete all memories for a room."""
        ...

    @abstractmethod
    async def count_memories(
        self, room_id: UUID, unique: bool = False, table_name: str | None = None
    ) -> int:
        """Count memories for a room."""
        ...

    # World methods
    @abstractmethod
    async def create_world(self, world: Any) -> UUID:
        """Create a world."""
        ...

    @abstractmethod
    async def get_world(self, id: UUID) -> Any | None:
        """Get world by ID."""
        ...

    @abstractmethod
    async def remove_world(self, id: UUID) -> None:
        """Remove a world."""
        ...

    @abstractmethod
    async def get_all_worlds(self) -> list[Any]:
        """Get all worlds."""
        ...

    @abstractmethod
    async def update_world(self, world: Any) -> None:
        """Update a world."""
        ...

    # Room methods
    @abstractmethod
    async def get_rooms_by_ids(self, room_ids: list[UUID]) -> list[Any] | None:
        """Get rooms by IDs."""
        ...

    @abstractmethod
    async def create_rooms(self, rooms: list[Any]) -> list[UUID]:
        """Create rooms."""
        ...

    @abstractmethod
    async def delete_room(self, room_id: UUID) -> None:
        """Delete a room."""
        ...

    @abstractmethod
    async def delete_rooms_by_world_id(self, world_id: UUID) -> None:
        """Delete rooms by world ID."""
        ...

    @abstractmethod
    async def update_room(self, room: Any) -> None:
        """Update a room."""
        ...

    # Participant methods
    @abstractmethod
    async def get_rooms_for_participant(self, entity_id: UUID) -> list[UUID]:
        """Get rooms for a participant."""
        ...

    @abstractmethod
    async def get_rooms_for_participants(self, user_ids: list[UUID]) -> list[UUID]:
        """Get rooms for participants."""
        ...

    @abstractmethod
    async def get_rooms_by_world(self, world_id: UUID) -> list[Any]:
        """Get rooms by world."""
        ...

    @abstractmethod
    async def remove_participant(self, entity_id: UUID, room_id: UUID) -> bool:
        """Remove a participant from a room."""
        ...

    @abstractmethod
    async def get_participants_for_entity(self, entity_id: UUID) -> list[Any]:
        """Get participants for an entity."""
        ...

    @abstractmethod
    async def get_participants_for_room(self, room_id: UUID) -> list[UUID]:
        """Get participants for a room."""
        ...

    @abstractmethod
    async def is_room_participant(self, room_id: UUID, entity_id: UUID) -> bool:
        """Check if entity is a room participant."""
        ...

    @abstractmethod
    async def add_participants_room(self, entity_ids: list[UUID], room_id: UUID) -> bool:
        """Add participants to a room."""
        ...

    @abstractmethod
    async def get_participant_user_state(self, room_id: UUID, entity_id: UUID) -> str | None:
        """Get participant user state."""
        ...

    @abstractmethod
    async def set_participant_user_state(
        self, room_id: UUID, entity_id: UUID, state: str | None
    ) -> None:
        """Set participant user state."""
        ...

    # Relationship methods
    @abstractmethod
    async def create_relationship(self, params: dict[str, Any]) -> bool:
        """Create a new relationship."""
        ...

    @abstractmethod
    async def update_relationship(self, relationship: Any) -> None:
        """Update an existing relationship."""
        ...

    @abstractmethod
    async def get_relationship(self, params: dict[str, Any]) -> Any | None:
        """Get a relationship between two entities."""
        ...

    @abstractmethod
    async def get_relationships(self, params: dict[str, Any]) -> list[Any]:
        """Get all relationships for an entity."""
        ...

    # Cache methods
    @abstractmethod
    async def get_cache(self, key: str) -> Any | None:
        """Get cached value."""
        ...

    @abstractmethod
    async def set_cache(self, key: str, value: Any) -> bool:
        """Set cached value."""
        ...

    @abstractmethod
    async def delete_cache(self, key: str) -> bool:
        """Delete cached value."""
        ...

    # Task methods
    @abstractmethod
    async def create_task(self, task: Any) -> UUID:
        """Create a task."""
        ...

    @abstractmethod
    async def get_tasks(self, params: dict[str, Any]) -> list[Any]:
        """Get tasks."""
        ...

    @abstractmethod
    async def get_task(self, id: UUID) -> Any | None:
        """Get task by ID."""
        ...

    @abstractmethod
    async def get_tasks_by_name(self, name: str) -> list[Any]:
        """Get tasks by name."""
        ...

    @abstractmethod
    async def update_task(self, id: UUID, task: dict[str, Any]) -> None:
        """Update a task."""
        ...

    @abstractmethod
    async def delete_task(self, id: UUID) -> None:
        """Delete a task."""
        ...

    @abstractmethod
    async def get_memories_by_world_id(self, params: dict[str, Any]) -> list[Any]:
        """Get memories by world ID."""
        ...
