"""
Runtime types for elizaOS.

This module defines the IAgentRuntime interface and related types.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field

from elizaos.types.database import IDatabaseAdapter
from elizaos.types.primitives import UUID, Content

if TYPE_CHECKING:
    from elizaos.types.agent import Character
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
    )
    from elizaos.types.plugin import Plugin, Route
    from elizaos.types.service import Service
    from elizaos.types.state import State
    from elizaos.types.task import TaskWorker


# Runtime settings type
RuntimeSettings = dict[str, str | bool | int | float | None]


# Send handler function type
SendHandlerFunction = Callable[[Any, Content], Awaitable[None]]


class TargetInfo(BaseModel):
    """Target information for sending messages."""

    room_id: UUID | None = Field(default=None, alias="roomId")
    entity_id: UUID | None = Field(default=None, alias="entityId")
    world_id: UUID | None = Field(default=None, alias="worldId")
    source: str | None = None

    model_config = {"populate_by_name": True, "extra": "allow"}


class IAgentRuntime(IDatabaseAdapter, ABC):
    """
    Represents the core runtime environment for an agent.
    Defines methods for database interaction, plugin management, event handling,
    state composition, model usage, and task management.
    """

    # Properties that must be implemented
    @property
    @abstractmethod
    def agent_id(self) -> UUID:
        """Get the agent's UUID."""
        ...

    @property
    @abstractmethod
    def character(self) -> Character:
        """Get the agent's character configuration."""
        ...

    @property
    @abstractmethod
    def providers(self) -> list[Provider]:
        """Get registered providers."""
        ...

    @property
    @abstractmethod
    def actions(self) -> list[Action]:
        """Get registered actions."""
        ...

    @property
    @abstractmethod
    def evaluators(self) -> list[Evaluator]:
        """Get registered evaluators."""
        ...

    @property
    @abstractmethod
    def plugins(self) -> list[Plugin]:
        """Get registered plugins."""
        ...

    @property
    @abstractmethod
    def services(self) -> dict[str, list[Service]]:
        """Get registered services."""
        ...

    @property
    @abstractmethod
    def routes(self) -> list[Route]:
        """Get registered routes."""
        ...

    # Plugin management
    @abstractmethod
    async def register_plugin(self, plugin: Plugin) -> None:
        """Register a plugin with the runtime."""
        ...

    @abstractmethod
    async def initialize(self, config: dict[str, str | int | bool | None] | None = None) -> None:
        """Initialize the runtime."""
        ...

    # Service management
    @abstractmethod
    def get_service(self, service: str) -> Service | None:
        """Get a service by type."""
        ...

    @abstractmethod
    def get_services_by_type(self, service: str) -> list[Service]:
        """Get all services of a type."""
        ...

    @abstractmethod
    def get_all_services(self) -> dict[str, list[Service]]:
        """Get all registered services."""
        ...

    @abstractmethod
    async def register_service(self, service: type[Service]) -> None:
        """Register a service class."""
        ...

    @abstractmethod
    async def get_service_load_promise(self, service_type: str) -> Service:
        """Get a promise that resolves when the service is loaded."""
        ...

    @abstractmethod
    def get_registered_service_types(self) -> list[str]:
        """Get all registered service types."""
        ...

    @abstractmethod
    def has_service(self, service_type: str) -> bool:
        """Check if a service is registered."""
        ...

    # Settings
    @abstractmethod
    def set_setting(self, key: str, value: str | bool | None, secret: bool = False) -> None:
        """Set a runtime setting."""
        ...

    @abstractmethod
    def get_setting(self, key: str) -> str | bool | int | float | None:
        """Get a runtime setting."""
        ...

    @abstractmethod
    def get_conversation_length(self) -> int:
        """Get the conversation length."""
        ...

    # Action processing
    @abstractmethod
    async def process_actions(
        self,
        message: Memory,
        responses: list[Memory],
        state: State | None = None,
        callback: HandlerCallback | None = None,
        options: dict[str, Any] | None = None,
    ) -> None:
        """Process actions for a message."""
        ...

    @abstractmethod
    def get_action_results(self, message_id: UUID) -> list[ActionResult]:
        """Get action results for a message."""
        ...

    # Evaluation
    @abstractmethod
    async def evaluate(
        self,
        message: Memory,
        state: State | None = None,
        did_respond: bool = False,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> list[Evaluator] | None:
        """Evaluate a message."""
        ...

    # Component registration
    @abstractmethod
    def register_provider(self, provider: Provider) -> None:
        """Register a provider."""
        ...

    @abstractmethod
    def register_action(self, action: Action) -> None:
        """Register an action."""
        ...

    @abstractmethod
    def register_evaluator(self, evaluator: Evaluator) -> None:
        """Register an evaluator."""
        ...

    # Connection management
    @abstractmethod
    async def ensure_connections(
        self,
        entities: list[Entity],
        rooms: list[Room],
        source: str,
        world: World,
    ) -> None:
        """Ensure connections are set up."""
        ...

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
    ) -> None:
        """Ensure a connection is set up."""
        ...

    @abstractmethod
    async def ensure_participant_in_room(self, entity_id: UUID, room_id: UUID) -> None:
        """Ensure an entity is a participant in a room."""
        ...

    @abstractmethod
    async def ensure_world_exists(self, world: World) -> None:
        """Ensure a world exists."""
        ...

    @abstractmethod
    async def ensure_room_exists(self, room: Room) -> None:
        """Ensure a room exists."""
        ...

    # State composition
    @abstractmethod
    async def compose_state(
        self,
        message: Memory,
        include_list: list[str] | None = None,
        only_include: bool = False,
        skip_cache: bool = False,
    ) -> State:
        """Compose state for a message."""
        ...

    # Model usage
    @abstractmethod
    async def use_model(
        self,
        model_type: str,
        params: dict[str, Any],
        provider: str | None = None,
    ) -> Any:
        """Use a model for inference."""
        ...

    @abstractmethod
    async def generate_text(
        self,
        input_text: str,
        options: GenerateTextOptions | None = None,
    ) -> GenerateTextResult:
        """Generate text using an LLM."""
        ...

    @abstractmethod
    def register_model(
        self,
        model_type: str,
        handler: Callable[[IAgentRuntime, dict[str, Any]], Awaitable[Any]],
        provider: str,
        priority: int = 0,
    ) -> None:
        """Register a model handler."""
        ...

    @abstractmethod
    def get_model(
        self, model_type: str
    ) -> Callable[[IAgentRuntime, dict[str, Any]], Awaitable[Any]] | None:
        """Get a model handler."""
        ...

    # Event handling
    @abstractmethod
    def register_event(
        self,
        event: str,
        handler: Callable[[Any], Awaitable[None]],
    ) -> None:
        """Register an event handler."""
        ...

    @abstractmethod
    def get_event(self, event: str) -> list[Callable[[Any], Awaitable[None]]] | None:
        """Get event handlers for an event type."""
        ...

    @abstractmethod
    async def emit_event(
        self,
        event: str | list[str],
        params: Any,
    ) -> None:
        """Emit an event."""
        ...

    # Task management
    @abstractmethod
    def register_task_worker(self, task_handler: TaskWorker) -> None:
        """Register a task worker."""
        ...

    @abstractmethod
    def get_task_worker(self, name: str) -> TaskWorker | None:
        """Get a task worker by name."""
        ...

    # Lifecycle
    @abstractmethod
    async def stop(self) -> None:
        """Stop the runtime."""
        ...

    # Memory/embedding helpers
    @abstractmethod
    async def add_embedding_to_memory(self, memory: Memory) -> Memory:
        """Add embedding to a memory."""
        ...

    @abstractmethod
    async def queue_embedding_generation(self, memory: Memory, priority: str = "normal") -> None:
        """Queue a memory for async embedding generation."""
        ...

    @abstractmethod
    async def get_all_memories(self) -> list[Memory]:
        """Get all memories."""
        ...

    @abstractmethod
    async def clear_all_agent_memories(self) -> None:
        """Clear all agent memories."""
        ...

    # Run tracking
    @abstractmethod
    def create_run_id(self) -> UUID:
        """Create a new run ID."""
        ...

    @abstractmethod
    def start_run(self, room_id: UUID | None = None) -> UUID:
        """Start a new run."""
        ...

    @abstractmethod
    def end_run(self) -> None:
        """End the current run."""
        ...

    @abstractmethod
    def get_current_run_id(self) -> UUID:
        """Get the current run ID."""
        ...

    # Convenience wrappers
    @abstractmethod
    async def get_entity_by_id(self, entity_id: UUID) -> Entity | None:
        """Get entity by ID."""
        ...

    @abstractmethod
    async def get_room(self, room_id: UUID) -> Room | None:
        """Get room by ID."""
        ...

    @abstractmethod
    async def create_entity(self, entity: Entity) -> bool:
        """Create an entity."""
        ...

    @abstractmethod
    async def create_room(self, room: Room) -> UUID:
        """Create a room."""
        ...

    @abstractmethod
    async def add_participant(self, entity_id: UUID, room_id: UUID) -> bool:
        """Add a participant to a room."""
        ...

    @abstractmethod
    async def get_rooms(self, world_id: UUID) -> list[Room]:
        """Get rooms for a world."""
        ...

    @abstractmethod
    def register_send_handler(self, source: str, handler: SendHandlerFunction) -> None:
        """Register a send handler."""
        ...

    @abstractmethod
    async def send_message_to_target(self, target: TargetInfo, content: Content) -> None:
        """Send a message to a target."""
        ...
