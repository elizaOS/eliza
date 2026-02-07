from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field

from elizaos.logger import Logger
from elizaos.types.database import IDatabaseAdapter
from elizaos.types.primitives import UUID, Content

if TYPE_CHECKING:
    from elizaos.types.agent import Character, TemplateType
    from elizaos.types.components import (
        Action,
        ActionResult,
        Evaluator,
        HandlerCallback,
        Provider,
    )
    from elizaos.types.environment import Entity, Room, World
    from elizaos.types.memory import Memory
    from elizaos.types.model import (
        GenerateTextOptions,
        GenerateTextResult,
        ModelType,
    )
    from elizaos.types.plugin import Plugin, Route
    from elizaos.types.service import Service
    from elizaos.types.state import State
    from elizaos.types.task import TaskWorker


# Type alias for streaming model handlers
StreamingModelHandler = Callable[["IAgentRuntime", dict[str, Any]], AsyncIterator[str]]


# Runtime settings type
RuntimeSettings = dict[str, str | bool | int | float | None]


# Send handler function type
SendHandlerFunction = Callable[[Any, Content], Awaitable[None]]


class TargetInfo(BaseModel):
    room_id: UUID | None = Field(default=None, alias="roomId")
    entity_id: UUID | None = Field(default=None, alias="entityId")
    world_id: UUID | None = Field(default=None, alias="worldId")
    source: str | None = None

    model_config = {"populate_by_name": True, "extra": "allow"}


class IAgentRuntime(ABC):
    # Properties that must be implemented
    @property
    @abstractmethod
    def agent_id(self) -> UUID: ...

    @property
    @abstractmethod
    def character(self) -> Character: ...

    @property
    @abstractmethod
    def providers(self) -> list[Provider]: ...

    @property
    @abstractmethod
    def actions(self) -> list[Action]: ...

    @property
    @abstractmethod
    def evaluators(self) -> list[Evaluator]: ...

    @property
    @abstractmethod
    def plugins(self) -> list[Plugin]: ...

    @property
    @abstractmethod
    def services(self) -> dict[str, list[Service]]: ...

    @property
    @abstractmethod
    def routes(self) -> list[Route]: ...

    @property
    @abstractmethod
    def events(self) -> dict[str, list[Callable[[Any], Awaitable[None]]]]: ...

    @property
    @abstractmethod
    def state_cache(self) -> dict[str, State]: ...

    @property
    @abstractmethod
    def message_service(self) -> Any | None: ...

    @property
    @abstractmethod
    def enable_autonomy(self) -> bool: ...

    @enable_autonomy.setter
    @abstractmethod
    def enable_autonomy(self, value: bool) -> None: ...

    # Database adapter
    @abstractmethod
    def register_database_adapter(self, adapter: IDatabaseAdapter) -> None: ...

    @abstractmethod
    async def get_connection(self) -> Any: ...

    @abstractmethod
    async def get_cache(self, key: str) -> object | None: ...

    @abstractmethod
    async def set_cache(self, key: str, value: object) -> bool: ...

    @abstractmethod
    async def delete_cache(self, key: str) -> None: ...

    @abstractmethod
    async def get_memories(
        self, params: dict[str, Any] | None = None, **kwargs: Any
    ) -> list[Any]: ...

    @abstractmethod
    async def create_memory(
        self,
        memory: dict[str, object] | None = None,
        table_name: str | None = None,
        unique: bool | None = None,
        **kwargs: object,
    ) -> Any: ...

    # Plugin management
    @abstractmethod
    async def register_plugin(self, plugin: Plugin) -> None: ...

    @abstractmethod
    async def initialize(
        self, config: dict[str, str | int | bool | None] | None = None
    ) -> None: ...

    # Service management
    @abstractmethod
    def get_service(self, service: str) -> Service | None: ...

    @abstractmethod
    def get_services_by_type(self, service: str) -> list[Service]: ...

    @abstractmethod
    def get_all_services(self) -> dict[str, list[Service]]: ...

    @abstractmethod
    async def register_service(self, service: type[Service]) -> None: ...

    @abstractmethod
    async def get_service_load_promise(self, service_type: str) -> Service: ...

    @abstractmethod
    def get_registered_service_types(self) -> list[str]: ...

    @abstractmethod
    def has_service(self, service_type: str) -> bool: ...

    # Settings
    @abstractmethod
    def set_setting(self, key: str, value: object | None, secret: bool = False) -> None: ...

    @abstractmethod
    def get_setting(self, key: str) -> object | None: ...

    @abstractmethod
    def get_all_settings(self) -> dict[str, object | None]: ...

    @abstractmethod
    def compose_prompt(self, *, state: State, template: TemplateType) -> str: ...

    @abstractmethod
    def compose_prompt_from_state(self, *, state: State, template: TemplateType) -> str: ...

    @abstractmethod
    def get_current_time_ms(self) -> int: ...

    @abstractmethod
    def get_conversation_length(self) -> int: ...

    @property
    @abstractmethod
    def logger(self) -> Logger: ...

    @abstractmethod
    def is_action_planning_enabled(self) -> bool: ...

    @abstractmethod
    def is_check_should_respond_enabled(self) -> bool: ...

    # Action processing
    @abstractmethod
    async def process_actions(
        self,
        message: Memory,
        responses: list[Memory],
        state: State | None = None,
        callback: HandlerCallback | None = None,
        options: dict[str, Any] | None = None,
    ) -> None: ...

    @abstractmethod
    def get_action_results(self, message_id: UUID) -> list[ActionResult]: ...

    # Evaluation
    @abstractmethod
    async def evaluate(
        self,
        message: Memory,
        state: State | None = None,
        did_respond: bool = False,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> list[Evaluator] | None: ...

    # Component registration
    @abstractmethod
    def register_provider(self, provider: Provider) -> None: ...

    @abstractmethod
    def register_action(self, action: Action) -> None: ...

    @abstractmethod
    def register_evaluator(self, evaluator: Evaluator) -> None: ...

    # Connection management
    @abstractmethod
    async def ensure_connections(
        self,
        entities: list[Entity],
        rooms: list[Room],
        source: str,
        world: World,
    ) -> None: ...

    @abstractmethod
    async def ensure_connection(
        self,
        entity_id: UUID,
        room_id: UUID,
        world_id: UUID,
        user_name: str | None = None,
        name: str | None = None,
        world_name: str | None = None,
        source: str | None = None,
        channel_id: str | None = None,
        message_server_id: UUID | None = None,
        channel_type: str | None = None,
        user_id: UUID | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None: ...

    @abstractmethod
    async def ensure_participant_in_room(self, entity_id: UUID, room_id: UUID) -> None: ...

    @abstractmethod
    async def ensure_world_exists(self, world: World) -> None: ...

    @abstractmethod
    async def ensure_room_exists(self, room: Room) -> None: ...

    # State composition
    @abstractmethod
    async def compose_state(
        self,
        message: Memory,
        include_list: list[str] | None = None,
        only_include: bool = False,
        skip_cache: bool = False,
    ) -> State: ...

    # Model usage
    @abstractmethod
    def has_model(self, model_type: str | ModelType) -> bool: ...

    @abstractmethod
    async def use_model(
        self,
        model_type: str | ModelType,
        params: dict[str, Any] | None = None,
        provider: str | None = None,
        **kwargs: Any,
    ) -> Any: ...

    @abstractmethod
    async def generate_text(
        self,
        input_text: str,
        options: GenerateTextOptions | None = None,
    ) -> GenerateTextResult: ...

    @abstractmethod
    def register_model(
        self,
        model_type: str | ModelType,
        handler: Callable[[IAgentRuntime, dict[str, Any]], Awaitable[Any]],
        provider: str,
        priority: int = 0,
    ) -> None: ...

    @abstractmethod
    def get_model(
        self, model_type: str
    ) -> Callable[[IAgentRuntime, dict[str, Any]], Awaitable[Any]] | None: ...

    @abstractmethod
    def use_model_stream(
        self,
        model_type: str | ModelType,
        params: dict[str, Any] | None = None,
        provider: str | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        """
        Use a streaming model handler to generate text token by token.

        Args:
            model_type: The model type (e.g., ModelType.TEXT_LARGE_STREAM)
            params: Parameters for the model (prompt, system, temperature, etc.)
            provider: Optional specific provider to use
            **kwargs: Additional parameters merged into params

        Returns:
            An async iterator yielding text chunks as they are generated.
        """
        ...

    @abstractmethod
    def register_streaming_model(
        self,
        model_type: str | ModelType,
        handler: StreamingModelHandler,
        provider: str,
        priority: int = 0,
    ) -> None:
        """Register a streaming model handler."""
        ...

    # Event handling
    @abstractmethod
    def register_event(
        self,
        event: str,
        handler: Callable[[Any], Awaitable[None]],
    ) -> None: ...

    @abstractmethod
    def get_event(self, event: str) -> list[Callable[[Any], Awaitable[None]]] | None: ...

    @abstractmethod
    async def emit_event(
        self,
        event: str | list[str],
        params: Any,
    ) -> None: ...

    # Task management
    @abstractmethod
    def register_task_worker(self, task_handler: TaskWorker) -> None: ...

    @abstractmethod
    def get_task_worker(self, name: str) -> TaskWorker | None: ...

    # Lifecycle
    @abstractmethod
    async def stop(self) -> None: ...

    # Memory/embedding helpers
    @abstractmethod
    async def add_embedding_to_memory(self, memory: Memory) -> Memory: ...

    @abstractmethod
    async def queue_embedding_generation(
        self, memory: Memory, priority: str = "normal"
    ) -> None: ...

    @abstractmethod
    async def get_all_memories(self) -> list[Memory]: ...

    @abstractmethod
    async def clear_all_agent_memories(self) -> None: ...

    @abstractmethod
    async def update_memory(self, memory: Memory | dict[str, Any]) -> bool: ...

    # Run tracking
    @abstractmethod
    def create_run_id(self) -> UUID: ...

    @abstractmethod
    def start_run(self, room_id: UUID | None = None) -> UUID: ...

    @abstractmethod
    def end_run(self) -> None: ...

    @abstractmethod
    def get_current_run_id(self) -> UUID: ...

    # Convenience wrappers
    @abstractmethod
    async def get_entity_by_id(self, entity_id: UUID) -> Entity | None: ...

    @abstractmethod
    async def get_entity(self, entity_id: UUID | str) -> Entity | None: ...

    @abstractmethod
    async def update_entity(self, entity: Entity) -> None: ...

    @abstractmethod
    async def get_room(self, room_id: UUID) -> Room | None: ...

    @abstractmethod
    async def create_entity(self, entity: Entity) -> bool: ...

    @abstractmethod
    async def create_room(self, room: Room) -> UUID: ...

    @abstractmethod
    async def add_participant(self, entity_id: UUID, room_id: UUID) -> bool: ...

    @abstractmethod
    async def get_rooms(self, world_id: UUID) -> list[Room]: ...

    @abstractmethod
    def register_send_handler(self, source: str, handler: SendHandlerFunction) -> None: ...

    @abstractmethod
    async def send_message_to_target(self, target: TargetInfo, content: Content) -> None: ...

    @abstractmethod
    async def update_world(self, world: World) -> None: ...

    @abstractmethod
    async def get_world(self, world_id: UUID) -> World | None: ...

    @abstractmethod
    async def get_relationships(self, params: dict[str, object]) -> list[object]: ...

    @abstractmethod
    async def search_knowledge(self, query: str, limit: int = 5) -> list[object]: ...
