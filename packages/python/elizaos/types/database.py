from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field

from elizaos.types.primitives import UUID

if TYPE_CHECKING:
    from elizaos.types.memory import Memory


class BaseLogBody(BaseModel):
    run_id: str | UUID | None = Field(default=None, alias="runId")
    status: str | None = None
    message_id: UUID | None = Field(default=None, alias="messageId")
    room_id: UUID | None = Field(default=None, alias="roomId")
    entity_id: UUID | None = Field(default=None, alias="entityId")
    metadata: dict[str, Any] | None = None

    model_config = {"populate_by_name": True, "extra": "allow"}


class ActionLogBody(BaseLogBody):
    action: str | None = None
    action_id: UUID | str | None = Field(default=None, alias="actionId")
    message: str | None = None
    state: Any | None = None
    responses: Any | None = None
    content: dict[str, Any] | None = None
    result: dict[str, Any] | None = None
    prompts: list[dict[str, Any]] | None = None
    prompt_count: int | None = Field(default=None, alias="promptCount")
    plan_step: str | None = Field(default=None, alias="planStep")
    plan_thought: str | None = Field(default=None, alias="planThought")


class EvaluatorLogBody(BaseLogBody):
    evaluator: str | None = None
    message: str | None = None
    state: Any | None = None


class ModelLogBody(BaseLogBody):
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
    memory_id: str | None = Field(default=None, alias="memoryId")
    duration: int | None = None


# Union type for all log body types
LogBody = BaseLogBody | ActionLogBody | EvaluatorLogBody | ModelLogBody | EmbeddingLogBody


class Log(BaseModel):
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
    actions: int = 0
    model_calls: int = Field(default=0, alias="modelCalls")
    errors: int = 0
    evaluators: int = 0

    model_config = {"populate_by_name": True}


class AgentRunSummary(BaseModel):
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
    runs: list[AgentRunSummary]
    total: int
    has_more: bool = Field(..., alias="hasMore")

    model_config = {"populate_by_name": True}


class EmbeddingSearchResult(BaseModel):
    embedding: list[float]
    levenshtein_score: float = Field(..., alias="levenshteinScore")

    model_config = {"populate_by_name": True}


class MemoryRetrievalOptions(BaseModel):
    room_id: UUID = Field(..., alias="roomId")
    count: int | None = None
    unique: bool | None = None
    start: int | None = None
    end: int | None = None
    agent_id: UUID | None = Field(default=None, alias="agentId")

    model_config = {"populate_by_name": True}


class MemorySearchOptions(BaseModel):
    embedding: list[float]
    match_threshold: float | None = Field(default=None, alias="matchThreshold")
    count: int | None = None
    room_id: UUID = Field(..., alias="roomId")
    agent_id: UUID | None = Field(default=None, alias="agentId")
    unique: bool | None = None
    metadata: dict[str, Any] | None = None

    model_config = {"populate_by_name": True}


class MultiRoomMemoryOptions(BaseModel):
    room_ids: list[UUID] = Field(..., alias="roomIds")
    limit: int | None = None
    agent_id: UUID | None = Field(default=None, alias="agentId")

    model_config = {"populate_by_name": True}


class MemoryOptions(BaseModel):
    room_id: UUID = Field(..., alias="roomId")
    limit: int | None = None
    agent_id: UUID | None = Field(default=None, alias="agentId")
    unique: bool | None = None
    start: int | None = None
    end: int | None = None

    model_config = {"populate_by_name": True}


class SearchOptions(MemoryOptions):
    embedding: list[float]
    similarity: float | None = None

    model_config = {"populate_by_name": True}


# Database connection type - actual type depends on adapter implementation
DbConnection = Any


# Vector dimension constants
class VECTOR_DIMS:
    SMALL = 384
    MEDIUM = 512
    LARGE = 768
    XL = 1024
    XXL = 1536
    XXXL = 3072


class IDatabaseAdapter(ABC):
    @property
    @abstractmethod
    def db(self) -> Any: ...

    @abstractmethod
    async def initialize(
        self, config: dict[str, str | int | bool | None] | None = None
    ) -> None: ...

    @abstractmethod
    async def init(self) -> None: ...

    async def run_plugin_migrations(
        self,
        plugins: list[dict[str, Any]],
        options: dict[str, bool] | None = None,
    ) -> None:
        _ = plugins, options

    async def run_migrations(self, migrations_paths: list[str] | None = None) -> None:
        _ = migrations_paths

    @abstractmethod
    async def is_ready(self) -> bool: ...

    @abstractmethod
    async def close(self) -> None: ...

    @abstractmethod
    async def get_connection(self) -> Any:
        """Get database connection."""
        ...

    async def with_entity_context(self, entity_id: UUID | None, callback: Any) -> Any:
        _ = entity_id
        return await callback()

    # Agent methods
    @abstractmethod
    async def get_agent(self, agent_id: UUID) -> Any | None: ...

    @abstractmethod
    async def get_agents(self) -> list[Any]: ...

    @abstractmethod
    async def create_agent(self, agent: Any) -> bool: ...

    @abstractmethod
    async def update_agent(self, agent_id: UUID, agent: Any) -> bool: ...

    @abstractmethod
    async def delete_agent(self, agent_id: UUID) -> bool: ...

    @abstractmethod
    async def ensure_embedding_dimension(self, dimension: int) -> None: ...

    # Entity methods
    @abstractmethod
    async def get_entities_by_ids(self, entity_ids: list[UUID]) -> list[Any] | None: ...

    @abstractmethod
    async def get_entities_for_room(
        self, room_id: UUID, include_components: bool = False
    ) -> list[Any]: ...

    @abstractmethod
    async def create_entities(self, entities: list[Any]) -> bool: ...

    @abstractmethod
    async def update_entity(self, entity: Any) -> None: ...

    # Component methods
    @abstractmethod
    async def get_component(
        self,
        entity_id: UUID,
        component_type: str,
        world_id: UUID | None = None,
        source_entity_id: UUID | None = None,
    ) -> Any | None: ...

    @abstractmethod
    async def get_components(
        self,
        entity_id: UUID,
        world_id: UUID | None = None,
        source_entity_id: UUID | None = None,
    ) -> list[Any]: ...

    @abstractmethod
    async def create_component(self, component: Any) -> bool: ...

    @abstractmethod
    async def update_component(self, component: Any) -> None: ...

    @abstractmethod
    async def delete_component(self, component_id: UUID) -> None: ...

    # Memory methods
    @abstractmethod
    async def get_memories(
        self,
        params: dict[str, Any],
    ) -> list[Any]: ...

    @abstractmethod
    async def get_memory_by_id(self, id: UUID) -> Any | None: ...

    @abstractmethod
    async def get_memories_by_ids(
        self, ids: list[UUID], table_name: str | None = None
    ) -> list[Any]: ...

    @abstractmethod
    async def get_memories_by_room_ids(self, params: dict[str, Any]) -> list[Any]: ...

    @abstractmethod
    async def get_cached_embeddings(self, params: dict[str, Any]) -> list[dict[str, Any]]: ...

    @abstractmethod
    async def log(self, params: dict[str, Any]) -> None: ...

    @abstractmethod
    async def get_logs(self, params: dict[str, Any]) -> list[Log]: ...

    @abstractmethod
    async def delete_log(self, log_id: UUID) -> None: ...

    async def get_agent_run_summaries(self, params: dict[str, Any]) -> AgentRunSummaryResult:
        _ = params
        return AgentRunSummaryResult(runs=[], total=0, hasMore=False)

    @abstractmethod
    async def search_memories(self, params: dict[str, Any]) -> list[Any]: ...

    @abstractmethod
    async def create_memory(self, memory: Any, table_name: str, unique: bool = False) -> UUID: ...

    @abstractmethod
    async def update_memory(self, memory: Memory | dict[str, Any]) -> bool: ...

    @abstractmethod
    async def delete_memory(self, memory_id: UUID) -> None: ...

    @abstractmethod
    async def delete_many_memories(self, memory_ids: list[UUID]) -> None: ...

    @abstractmethod
    async def delete_all_memories(self, room_id: UUID, table_name: str) -> None: ...

    @abstractmethod
    async def count_memories(
        self, room_id: UUID, unique: bool = False, table_name: str | None = None
    ) -> int: ...

    # World methods
    @abstractmethod
    async def create_world(self, world: Any) -> UUID: ...

    @abstractmethod
    async def get_world(self, id: UUID) -> Any | None: ...

    @abstractmethod
    async def remove_world(self, id: UUID) -> None: ...

    @abstractmethod
    async def get_all_worlds(self) -> list[Any]: ...

    @abstractmethod
    async def update_world(self, world: Any) -> None: ...

    # Room methods
    @abstractmethod
    async def get_rooms_by_ids(self, room_ids: list[UUID]) -> list[Any] | None: ...

    @abstractmethod
    async def create_rooms(self, rooms: list[Any]) -> list[UUID]: ...

    @abstractmethod
    async def delete_room(self, room_id: UUID) -> None: ...

    @abstractmethod
    async def delete_rooms_by_world_id(self, world_id: UUID) -> None: ...

    @abstractmethod
    async def update_room(self, room: Any) -> None: ...

    # Participant methods
    @abstractmethod
    async def get_rooms_for_participant(self, entity_id: UUID) -> list[UUID]: ...

    @abstractmethod
    async def get_rooms_for_participants(self, user_ids: list[UUID]) -> list[UUID]: ...

    @abstractmethod
    async def get_rooms_by_world(self, world_id: UUID) -> list[Any]: ...

    @abstractmethod
    async def remove_participant(self, entity_id: UUID, room_id: UUID) -> bool: ...

    @abstractmethod
    async def get_participants_for_entity(self, entity_id: UUID) -> list[Any]: ...

    @abstractmethod
    async def get_participants_for_room(self, room_id: UUID) -> list[UUID]: ...

    @abstractmethod
    async def is_room_participant(self, room_id: UUID, entity_id: UUID) -> bool: ...

    @abstractmethod
    async def add_participants_room(self, entity_ids: list[UUID], room_id: UUID) -> bool: ...

    @abstractmethod
    async def get_participant_user_state(self, room_id: UUID, entity_id: UUID) -> str | None: ...

    @abstractmethod
    async def set_participant_user_state(
        self, room_id: UUID, entity_id: UUID, state: str | None
    ) -> None: ...

    # Relationship methods
    @abstractmethod
    async def create_relationship(self, params: dict[str, Any]) -> bool: ...

    @abstractmethod
    async def update_relationship(self, relationship: Any) -> None: ...

    @abstractmethod
    async def get_relationship(self, params: dict[str, Any]) -> Any | None: ...

    @abstractmethod
    async def get_relationships(self, params: dict[str, Any]) -> list[Any]: ...

    # Cache methods
    @abstractmethod
    async def get_cache(self, key: str) -> Any | None: ...

    @abstractmethod
    async def set_cache(self, key: str, value: Any) -> bool: ...

    @abstractmethod
    async def delete_cache(self, key: str) -> bool: ...

    # Task methods
    @abstractmethod
    async def create_task(self, task: Any) -> UUID: ...

    @abstractmethod
    async def get_tasks(self, params: dict[str, Any]) -> list[Any]: ...

    @abstractmethod
    async def get_task(self, id: UUID) -> Any | None: ...

    @abstractmethod
    async def get_tasks_by_name(self, name: str) -> list[Any]: ...

    @abstractmethod
    async def update_task(self, id: UUID, task: dict[str, Any]) -> None: ...

    @abstractmethod
    async def delete_task(self, id: UUID) -> None: ...

    @abstractmethod
    async def get_memories_by_world_id(self, params: dict[str, Any]) -> list[Any]: ...
