from __future__ import annotations

from collections.abc import Awaitable, Callable
from enum import Enum
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field

from elizaos.types.primitives import UUID, Content

if TYPE_CHECKING:
    pass


class EventType(str, Enum):
    # World events
    WORLD_JOINED = "WORLD_JOINED"
    WORLD_CONNECTED = "WORLD_CONNECTED"
    WORLD_LEFT = "WORLD_LEFT"

    # Entity events
    ENTITY_JOINED = "ENTITY_JOINED"
    ENTITY_LEFT = "ENTITY_LEFT"
    ENTITY_UPDATED = "ENTITY_UPDATED"

    # Room events
    ROOM_JOINED = "ROOM_JOINED"
    ROOM_LEFT = "ROOM_LEFT"

    # Message events
    MESSAGE_RECEIVED = "MESSAGE_RECEIVED"
    MESSAGE_SENT = "MESSAGE_SENT"
    MESSAGE_DELETED = "MESSAGE_DELETED"

    # Channel events
    CHANNEL_CLEARED = "CHANNEL_CLEARED"

    # Voice events
    VOICE_MESSAGE_RECEIVED = "VOICE_MESSAGE_RECEIVED"
    VOICE_MESSAGE_SENT = "VOICE_MESSAGE_SENT"

    # Interaction events
    REACTION_RECEIVED = "REACTION_RECEIVED"
    POST_GENERATED = "POST_GENERATED"
    INTERACTION_RECEIVED = "INTERACTION_RECEIVED"

    # Run events
    RUN_STARTED = "RUN_STARTED"
    RUN_ENDED = "RUN_ENDED"
    RUN_TIMEOUT = "RUN_TIMEOUT"

    # Action events
    ACTION_STARTED = "ACTION_STARTED"
    ACTION_COMPLETED = "ACTION_COMPLETED"

    # Evaluator events
    EVALUATOR_STARTED = "EVALUATOR_STARTED"
    EVALUATOR_COMPLETED = "EVALUATOR_COMPLETED"

    # Model events
    MODEL_USED = "MODEL_USED"

    # Embedding events
    EMBEDDING_GENERATION_REQUESTED = "EMBEDDING_GENERATION_REQUESTED"
    EMBEDDING_GENERATION_COMPLETED = "EMBEDDING_GENERATION_COMPLETED"
    EMBEDDING_GENERATION_FAILED = "EMBEDDING_GENERATION_FAILED"

    # Control events
    CONTROL_MESSAGE = "CONTROL_MESSAGE"


class PlatformPrefix(str, Enum):
    DISCORD = "DISCORD"
    TELEGRAM = "TELEGRAM"
    X = "X"


class EventPayload(BaseModel):
    runtime: Any = Field(..., description="Agent runtime")
    source: str = Field(..., description="Event source")
    on_complete: Callable[[], None] | None = Field(
        default=None, alias="onComplete", description="Completion callback"
    )

    model_config = {"populate_by_name": True, "arbitrary_types_allowed": True}


class WorldPayload(EventPayload):
    world: Any = Field(..., description="World object")
    rooms: list[Any] = Field(..., description="Rooms in the world")
    entities: list[Any] = Field(..., description="Entities in the world")


class EntityPayload(EventPayload):
    entity_id: UUID = Field(..., alias="entityId", description="Entity ID")
    world_id: UUID | None = Field(default=None, alias="worldId", description="World ID")
    room_id: UUID | None = Field(default=None, alias="roomId", description="Room ID")
    metadata: dict[str, Any] | None = Field(default=None, description="Entity metadata")

    model_config = {"populate_by_name": True, "arbitrary_types_allowed": True}


class MessagePayload(EventPayload):
    message: Any = Field(..., description="Message memory")
    callback: Callable[[Content], Awaitable[list[Any]]] | None = Field(
        default=None, description="Message callback"
    )

    model_config = {"arbitrary_types_allowed": True}


class ChannelClearedPayload(EventPayload):
    room_id: UUID = Field(..., alias="roomId", description="Room ID")
    channel_id: str = Field(..., alias="channelId", description="Channel ID")
    memory_count: int = Field(..., alias="memoryCount", description="Number of memories cleared")

    model_config = {"populate_by_name": True, "arbitrary_types_allowed": True}


class InvokePayload(EventPayload):
    """Payload for events invoked without a message."""

    world_id: UUID = Field(..., alias="worldId", description="World ID")
    user_id: str = Field(..., alias="userId", description="User ID")
    room_id: UUID = Field(..., alias="roomId", description="Room ID")
    callback: Callable[[Content], Awaitable[list[Any]]] | None = Field(
        default=None, description="Callback"
    )

    model_config = {"populate_by_name": True, "arbitrary_types_allowed": True}


class RunEventPayload(EventPayload):
    run_id: UUID = Field(..., alias="runId", description="Run ID")
    message_id: UUID = Field(..., alias="messageId", description="Message ID")
    room_id: UUID = Field(..., alias="roomId", description="Room ID")
    entity_id: UUID = Field(..., alias="entityId", description="Entity ID")
    start_time: int = Field(..., alias="startTime", description="Start time")
    status: str = Field(..., description="Run status")
    end_time: int | None = Field(default=None, alias="endTime", description="End time")
    duration: int | None = Field(default=None, description="Duration in ms")
    error: str | None = Field(default=None, description="Error message")

    model_config = {"populate_by_name": True, "arbitrary_types_allowed": True}


class ActionEventPayload(EventPayload):
    room_id: UUID = Field(..., alias="roomId", description="Room ID")
    world: UUID = Field(..., description="World ID")
    content: Content = Field(..., description="Content")
    message_id: UUID | None = Field(default=None, alias="messageId", description="Message ID")

    model_config = {"populate_by_name": True, "arbitrary_types_allowed": True}


class EvaluatorEventPayload(EventPayload):
    evaluator_id: UUID = Field(..., alias="evaluatorId", description="Evaluator ID")
    evaluator_name: str = Field(..., alias="evaluatorName", description="Evaluator name")
    start_time: int | None = Field(default=None, alias="startTime", description="Start time")
    completed: bool | None = Field(default=None, description="Whether completed")
    error: Exception | None = Field(default=None, description="Error if failed")

    model_config = {"populate_by_name": True, "arbitrary_types_allowed": True}


class ModelEventPayload(EventPayload):
    provider: str = Field(..., description="Model provider")
    type: str = Field(..., description="Model type")
    prompt: str = Field(..., description="Prompt")
    tokens: dict[str, int] | None = Field(default=None, description="Token counts")

    model_config = {"populate_by_name": True, "arbitrary_types_allowed": True}


class EmbeddingGenerationPayload(EventPayload):
    memory: Any = Field(..., description="Memory to embed")
    priority: str | None = Field(default=None, description="Priority level")
    retry_count: int | None = Field(default=None, alias="retryCount", description="Retry count")
    max_retries: int | None = Field(default=None, alias="maxRetries", description="Max retries")
    embedding: list[float] | None = Field(default=None, description="Embedding vector")
    error: Exception | str | Any | None = Field(default=None, description="Error")
    run_id: UUID | None = Field(default=None, alias="runId", description="Run ID")

    model_config = {"populate_by_name": True, "arbitrary_types_allowed": True}


class ControlMessage(BaseModel):
    type: str = Field(..., description="Control message type")
    data: dict[str, Any] | None = Field(default=None, description="Message data")

    model_config = {"extra": "allow"}


class ControlMessagePayload(EventPayload):
    message: ControlMessage = Field(..., description="Control message")


# Event handler type
EventHandler = Callable[[EventPayload], Awaitable[None]]

# Event payload map type - maps event types to their payload types
EventPayloadMap = dict[EventType, type[EventPayload]]
