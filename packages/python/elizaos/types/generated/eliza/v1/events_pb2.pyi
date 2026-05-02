from eliza.v1 import environment_pb2 as _environment_pb2
from eliza.v1 import memory_pb2 as _memory_pb2
from eliza.v1 import model_pb2 as _model_pb2
from eliza.v1 import primitives_pb2 as _primitives_pb2
from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class EventType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    EVENT_TYPE_UNSPECIFIED: _ClassVar[EventType]
    EVENT_TYPE_WORLD_JOINED: _ClassVar[EventType]
    EVENT_TYPE_WORLD_CONNECTED: _ClassVar[EventType]
    EVENT_TYPE_WORLD_LEFT: _ClassVar[EventType]
    EVENT_TYPE_ENTITY_JOINED: _ClassVar[EventType]
    EVENT_TYPE_ENTITY_LEFT: _ClassVar[EventType]
    EVENT_TYPE_ENTITY_UPDATED: _ClassVar[EventType]
    EVENT_TYPE_ROOM_JOINED: _ClassVar[EventType]
    EVENT_TYPE_ROOM_LEFT: _ClassVar[EventType]
    EVENT_TYPE_MESSAGE_RECEIVED: _ClassVar[EventType]
    EVENT_TYPE_MESSAGE_SENT: _ClassVar[EventType]
    EVENT_TYPE_MESSAGE_DELETED: _ClassVar[EventType]
    EVENT_TYPE_CHANNEL_CLEARED: _ClassVar[EventType]
    EVENT_TYPE_VOICE_MESSAGE_RECEIVED: _ClassVar[EventType]
    EVENT_TYPE_VOICE_MESSAGE_SENT: _ClassVar[EventType]
    EVENT_TYPE_REACTION_RECEIVED: _ClassVar[EventType]
    EVENT_TYPE_POST_GENERATED: _ClassVar[EventType]
    EVENT_TYPE_INTERACTION_RECEIVED: _ClassVar[EventType]
    EVENT_TYPE_RUN_STARTED: _ClassVar[EventType]
    EVENT_TYPE_RUN_ENDED: _ClassVar[EventType]
    EVENT_TYPE_RUN_TIMEOUT: _ClassVar[EventType]
    EVENT_TYPE_ACTION_STARTED: _ClassVar[EventType]
    EVENT_TYPE_ACTION_COMPLETED: _ClassVar[EventType]
    EVENT_TYPE_EVALUATOR_STARTED: _ClassVar[EventType]
    EVENT_TYPE_EVALUATOR_COMPLETED: _ClassVar[EventType]
    EVENT_TYPE_MODEL_USED: _ClassVar[EventType]
    EVENT_TYPE_EMBEDDING_GENERATION_REQUESTED: _ClassVar[EventType]
    EVENT_TYPE_EMBEDDING_GENERATION_COMPLETED: _ClassVar[EventType]
    EVENT_TYPE_EMBEDDING_GENERATION_FAILED: _ClassVar[EventType]
    EVENT_TYPE_CONTROL_MESSAGE: _ClassVar[EventType]

class PlatformPrefix(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    PLATFORM_PREFIX_UNSPECIFIED: _ClassVar[PlatformPrefix]
    PLATFORM_PREFIX_DISCORD: _ClassVar[PlatformPrefix]
    PLATFORM_PREFIX_TELEGRAM: _ClassVar[PlatformPrefix]
    PLATFORM_PREFIX_X: _ClassVar[PlatformPrefix]

class RunStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    RUN_STATUS_UNSPECIFIED: _ClassVar[RunStatus]
    RUN_STATUS_STARTED: _ClassVar[RunStatus]
    RUN_STATUS_COMPLETED: _ClassVar[RunStatus]
    RUN_STATUS_TIMEOUT: _ClassVar[RunStatus]

class EmbeddingPriority(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    EMBEDDING_PRIORITY_UNSPECIFIED: _ClassVar[EmbeddingPriority]
    EMBEDDING_PRIORITY_HIGH: _ClassVar[EmbeddingPriority]
    EMBEDDING_PRIORITY_NORMAL: _ClassVar[EmbeddingPriority]
    EMBEDDING_PRIORITY_LOW: _ClassVar[EmbeddingPriority]

class ControlMessageAction(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    CONTROL_MESSAGE_ACTION_UNSPECIFIED: _ClassVar[ControlMessageAction]
    CONTROL_MESSAGE_ACTION_DISABLE_INPUT: _ClassVar[ControlMessageAction]
    CONTROL_MESSAGE_ACTION_ENABLE_INPUT: _ClassVar[ControlMessageAction]
EVENT_TYPE_UNSPECIFIED: EventType
EVENT_TYPE_WORLD_JOINED: EventType
EVENT_TYPE_WORLD_CONNECTED: EventType
EVENT_TYPE_WORLD_LEFT: EventType
EVENT_TYPE_ENTITY_JOINED: EventType
EVENT_TYPE_ENTITY_LEFT: EventType
EVENT_TYPE_ENTITY_UPDATED: EventType
EVENT_TYPE_ROOM_JOINED: EventType
EVENT_TYPE_ROOM_LEFT: EventType
EVENT_TYPE_MESSAGE_RECEIVED: EventType
EVENT_TYPE_MESSAGE_SENT: EventType
EVENT_TYPE_MESSAGE_DELETED: EventType
EVENT_TYPE_CHANNEL_CLEARED: EventType
EVENT_TYPE_VOICE_MESSAGE_RECEIVED: EventType
EVENT_TYPE_VOICE_MESSAGE_SENT: EventType
EVENT_TYPE_REACTION_RECEIVED: EventType
EVENT_TYPE_POST_GENERATED: EventType
EVENT_TYPE_INTERACTION_RECEIVED: EventType
EVENT_TYPE_RUN_STARTED: EventType
EVENT_TYPE_RUN_ENDED: EventType
EVENT_TYPE_RUN_TIMEOUT: EventType
EVENT_TYPE_ACTION_STARTED: EventType
EVENT_TYPE_ACTION_COMPLETED: EventType
EVENT_TYPE_EVALUATOR_STARTED: EventType
EVENT_TYPE_EVALUATOR_COMPLETED: EventType
EVENT_TYPE_MODEL_USED: EventType
EVENT_TYPE_EMBEDDING_GENERATION_REQUESTED: EventType
EVENT_TYPE_EMBEDDING_GENERATION_COMPLETED: EventType
EVENT_TYPE_EMBEDDING_GENERATION_FAILED: EventType
EVENT_TYPE_CONTROL_MESSAGE: EventType
PLATFORM_PREFIX_UNSPECIFIED: PlatformPrefix
PLATFORM_PREFIX_DISCORD: PlatformPrefix
PLATFORM_PREFIX_TELEGRAM: PlatformPrefix
PLATFORM_PREFIX_X: PlatformPrefix
RUN_STATUS_UNSPECIFIED: RunStatus
RUN_STATUS_STARTED: RunStatus
RUN_STATUS_COMPLETED: RunStatus
RUN_STATUS_TIMEOUT: RunStatus
EMBEDDING_PRIORITY_UNSPECIFIED: EmbeddingPriority
EMBEDDING_PRIORITY_HIGH: EmbeddingPriority
EMBEDDING_PRIORITY_NORMAL: EmbeddingPriority
EMBEDDING_PRIORITY_LOW: EmbeddingPriority
CONTROL_MESSAGE_ACTION_UNSPECIFIED: ControlMessageAction
CONTROL_MESSAGE_ACTION_DISABLE_INPUT: ControlMessageAction
CONTROL_MESSAGE_ACTION_ENABLE_INPUT: ControlMessageAction

class EventPayload(_message.Message):
    __slots__ = ("source",)
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    source: str
    def __init__(self, source: _Optional[str] = ...) -> None: ...

class WorldPayload(_message.Message):
    __slots__ = ("source", "world", "rooms", "entities")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    WORLD_FIELD_NUMBER: _ClassVar[int]
    ROOMS_FIELD_NUMBER: _ClassVar[int]
    ENTITIES_FIELD_NUMBER: _ClassVar[int]
    source: str
    world: _environment_pb2.World
    rooms: _containers.RepeatedCompositeFieldContainer[_environment_pb2.Room]
    entities: _containers.RepeatedCompositeFieldContainer[_environment_pb2.Entity]
    def __init__(self, source: _Optional[str] = ..., world: _Optional[_Union[_environment_pb2.World, _Mapping]] = ..., rooms: _Optional[_Iterable[_Union[_environment_pb2.Room, _Mapping]]] = ..., entities: _Optional[_Iterable[_Union[_environment_pb2.Entity, _Mapping]]] = ...) -> None: ...

class EntityPayload(_message.Message):
    __slots__ = ("source", "entity_id", "world_id", "room_id", "metadata")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    ENTITY_ID_FIELD_NUMBER: _ClassVar[int]
    WORLD_ID_FIELD_NUMBER: _ClassVar[int]
    ROOM_ID_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    source: str
    entity_id: str
    world_id: str
    room_id: str
    metadata: EntityMetadata
    def __init__(self, source: _Optional[str] = ..., entity_id: _Optional[str] = ..., world_id: _Optional[str] = ..., room_id: _Optional[str] = ..., metadata: _Optional[_Union[EntityMetadata, _Mapping]] = ...) -> None: ...

class EntityMetadata(_message.Message):
    __slots__ = ("original_id", "username", "display_name", "extra")
    ORIGINAL_ID_FIELD_NUMBER: _ClassVar[int]
    USERNAME_FIELD_NUMBER: _ClassVar[int]
    DISPLAY_NAME_FIELD_NUMBER: _ClassVar[int]
    EXTRA_FIELD_NUMBER: _ClassVar[int]
    original_id: str
    username: str
    display_name: str
    extra: _struct_pb2.Struct
    def __init__(self, original_id: _Optional[str] = ..., username: _Optional[str] = ..., display_name: _Optional[str] = ..., extra: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class MessagePayload(_message.Message):
    __slots__ = ("source", "message")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    source: str
    message: _memory_pb2.Memory
    def __init__(self, source: _Optional[str] = ..., message: _Optional[_Union[_memory_pb2.Memory, _Mapping]] = ...) -> None: ...

class ChannelClearedPayload(_message.Message):
    __slots__ = ("source", "room_id", "channel_id", "memory_count")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    ROOM_ID_FIELD_NUMBER: _ClassVar[int]
    CHANNEL_ID_FIELD_NUMBER: _ClassVar[int]
    MEMORY_COUNT_FIELD_NUMBER: _ClassVar[int]
    source: str
    room_id: str
    channel_id: str
    memory_count: int
    def __init__(self, source: _Optional[str] = ..., room_id: _Optional[str] = ..., channel_id: _Optional[str] = ..., memory_count: _Optional[int] = ...) -> None: ...

class InvokePayload(_message.Message):
    __slots__ = ("source", "world_id", "user_id", "room_id")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    WORLD_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    ROOM_ID_FIELD_NUMBER: _ClassVar[int]
    source: str
    world_id: str
    user_id: str
    room_id: str
    def __init__(self, source: _Optional[str] = ..., world_id: _Optional[str] = ..., user_id: _Optional[str] = ..., room_id: _Optional[str] = ...) -> None: ...

class RunEventPayload(_message.Message):
    __slots__ = ("source", "run_id", "message_id", "room_id", "entity_id", "start_time", "status", "end_time", "duration", "error")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    RUN_ID_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    ROOM_ID_FIELD_NUMBER: _ClassVar[int]
    ENTITY_ID_FIELD_NUMBER: _ClassVar[int]
    START_TIME_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    END_TIME_FIELD_NUMBER: _ClassVar[int]
    DURATION_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    source: str
    run_id: str
    message_id: str
    room_id: str
    entity_id: str
    start_time: int
    status: RunStatus
    end_time: int
    duration: int
    error: str
    def __init__(self, source: _Optional[str] = ..., run_id: _Optional[str] = ..., message_id: _Optional[str] = ..., room_id: _Optional[str] = ..., entity_id: _Optional[str] = ..., start_time: _Optional[int] = ..., status: _Optional[_Union[RunStatus, str]] = ..., end_time: _Optional[int] = ..., duration: _Optional[int] = ..., error: _Optional[str] = ...) -> None: ...

class ActionEventPayload(_message.Message):
    __slots__ = ("source", "room_id", "world_id", "content", "message_id")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    ROOM_ID_FIELD_NUMBER: _ClassVar[int]
    WORLD_ID_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    source: str
    room_id: str
    world_id: str
    content: _primitives_pb2.Content
    message_id: str
    def __init__(self, source: _Optional[str] = ..., room_id: _Optional[str] = ..., world_id: _Optional[str] = ..., content: _Optional[_Union[_primitives_pb2.Content, _Mapping]] = ..., message_id: _Optional[str] = ...) -> None: ...

class EvaluatorEventPayload(_message.Message):
    __slots__ = ("source", "evaluator_id", "evaluator_name", "start_time", "completed", "error")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    EVALUATOR_ID_FIELD_NUMBER: _ClassVar[int]
    EVALUATOR_NAME_FIELD_NUMBER: _ClassVar[int]
    START_TIME_FIELD_NUMBER: _ClassVar[int]
    COMPLETED_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    source: str
    evaluator_id: str
    evaluator_name: str
    start_time: int
    completed: bool
    error: str
    def __init__(self, source: _Optional[str] = ..., evaluator_id: _Optional[str] = ..., evaluator_name: _Optional[str] = ..., start_time: _Optional[int] = ..., completed: bool = ..., error: _Optional[str] = ...) -> None: ...

class ModelTokenUsage(_message.Message):
    __slots__ = ("prompt", "completion", "total")
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    COMPLETION_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    prompt: int
    completion: int
    total: int
    def __init__(self, prompt: _Optional[int] = ..., completion: _Optional[int] = ..., total: _Optional[int] = ...) -> None: ...

class ModelEventPayload(_message.Message):
    __slots__ = ("source", "provider", "type", "prompt", "tokens")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    TOKENS_FIELD_NUMBER: _ClassVar[int]
    source: str
    provider: str
    type: _model_pb2.ModelType
    prompt: str
    tokens: ModelTokenUsage
    def __init__(self, source: _Optional[str] = ..., provider: _Optional[str] = ..., type: _Optional[_Union[_model_pb2.ModelType, str]] = ..., prompt: _Optional[str] = ..., tokens: _Optional[_Union[ModelTokenUsage, _Mapping]] = ...) -> None: ...

class EmbeddingGenerationPayload(_message.Message):
    __slots__ = ("source", "memory", "priority", "retry_count", "max_retries", "embedding", "error", "run_id")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    MEMORY_FIELD_NUMBER: _ClassVar[int]
    PRIORITY_FIELD_NUMBER: _ClassVar[int]
    RETRY_COUNT_FIELD_NUMBER: _ClassVar[int]
    MAX_RETRIES_FIELD_NUMBER: _ClassVar[int]
    EMBEDDING_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    RUN_ID_FIELD_NUMBER: _ClassVar[int]
    source: str
    memory: _memory_pb2.Memory
    priority: EmbeddingPriority
    retry_count: int
    max_retries: int
    embedding: _containers.RepeatedScalarFieldContainer[float]
    error: str
    run_id: str
    def __init__(self, source: _Optional[str] = ..., memory: _Optional[_Union[_memory_pb2.Memory, _Mapping]] = ..., priority: _Optional[_Union[EmbeddingPriority, str]] = ..., retry_count: _Optional[int] = ..., max_retries: _Optional[int] = ..., embedding: _Optional[_Iterable[float]] = ..., error: _Optional[str] = ..., run_id: _Optional[str] = ...) -> None: ...

class UIControlPayload(_message.Message):
    __slots__ = ("action", "target", "reason", "duration")
    ACTION_FIELD_NUMBER: _ClassVar[int]
    TARGET_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    DURATION_FIELD_NUMBER: _ClassVar[int]
    action: ControlMessageAction
    target: str
    reason: str
    duration: int
    def __init__(self, action: _Optional[_Union[ControlMessageAction, str]] = ..., target: _Optional[str] = ..., reason: _Optional[str] = ..., duration: _Optional[int] = ...) -> None: ...

class ControlMessage(_message.Message):
    __slots__ = ("type", "payload", "room_id")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    PAYLOAD_FIELD_NUMBER: _ClassVar[int]
    ROOM_ID_FIELD_NUMBER: _ClassVar[int]
    type: str
    payload: UIControlPayload
    room_id: str
    def __init__(self, type: _Optional[str] = ..., payload: _Optional[_Union[UIControlPayload, _Mapping]] = ..., room_id: _Optional[str] = ...) -> None: ...

class ControlMessagePayload(_message.Message):
    __slots__ = ("source", "message")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    source: str
    message: ControlMessage
    def __init__(self, source: _Optional[str] = ..., message: _Optional[_Union[ControlMessage, _Mapping]] = ...) -> None: ...
