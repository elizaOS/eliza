from eliza.v1 import components_pb2 as _components_pb2
from eliza.v1 import environment_pb2 as _environment_pb2
from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ActionPlanStep(_message.Message):
    __slots__ = ("action", "status", "error", "result")
    ACTION_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    RESULT_FIELD_NUMBER: _ClassVar[int]
    action: str
    status: str
    error: str
    result: _components_pb2.ActionResult
    def __init__(self, action: _Optional[str] = ..., status: _Optional[str] = ..., error: _Optional[str] = ..., result: _Optional[_Union[_components_pb2.ActionResult, _Mapping]] = ...) -> None: ...

class ActionPlan(_message.Message):
    __slots__ = ("thought", "total_steps", "current_step", "steps", "metadata")
    THOUGHT_FIELD_NUMBER: _ClassVar[int]
    TOTAL_STEPS_FIELD_NUMBER: _ClassVar[int]
    CURRENT_STEP_FIELD_NUMBER: _ClassVar[int]
    STEPS_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    thought: str
    total_steps: int
    current_step: int
    steps: _containers.RepeatedCompositeFieldContainer[ActionPlanStep]
    metadata: _struct_pb2.Struct
    def __init__(self, thought: _Optional[str] = ..., total_steps: _Optional[int] = ..., current_step: _Optional[int] = ..., steps: _Optional[_Iterable[_Union[ActionPlanStep, _Mapping]]] = ..., metadata: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class ProviderCacheEntry(_message.Message):
    __slots__ = ("text", "values", "data")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    VALUES_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    text: str
    values: _struct_pb2.Struct
    data: _struct_pb2.Struct
    def __init__(self, text: _Optional[str] = ..., values: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., data: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class WorkingMemoryItem(_message.Message):
    __slots__ = ("action_name", "result", "timestamp")
    ACTION_NAME_FIELD_NUMBER: _ClassVar[int]
    RESULT_FIELD_NUMBER: _ClassVar[int]
    TIMESTAMP_FIELD_NUMBER: _ClassVar[int]
    action_name: str
    result: _components_pb2.ActionResult
    timestamp: int
    def __init__(self, action_name: _Optional[str] = ..., result: _Optional[_Union[_components_pb2.ActionResult, _Mapping]] = ..., timestamp: _Optional[int] = ...) -> None: ...

class StateData(_message.Message):
    __slots__ = ("room", "world", "entity", "providers", "action_plan", "action_results", "working_memory", "extra")
    class ProvidersEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: ProviderCacheEntry
        def __init__(self, key: _Optional[str] = ..., value: _Optional[_Union[ProviderCacheEntry, _Mapping]] = ...) -> None: ...
    class WorkingMemoryEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: WorkingMemoryItem
        def __init__(self, key: _Optional[str] = ..., value: _Optional[_Union[WorkingMemoryItem, _Mapping]] = ...) -> None: ...
    ROOM_FIELD_NUMBER: _ClassVar[int]
    WORLD_FIELD_NUMBER: _ClassVar[int]
    ENTITY_FIELD_NUMBER: _ClassVar[int]
    PROVIDERS_FIELD_NUMBER: _ClassVar[int]
    ACTION_PLAN_FIELD_NUMBER: _ClassVar[int]
    ACTION_RESULTS_FIELD_NUMBER: _ClassVar[int]
    WORKING_MEMORY_FIELD_NUMBER: _ClassVar[int]
    EXTRA_FIELD_NUMBER: _ClassVar[int]
    room: _environment_pb2.Room
    world: _environment_pb2.World
    entity: _environment_pb2.Entity
    providers: _containers.MessageMap[str, ProviderCacheEntry]
    action_plan: ActionPlan
    action_results: _containers.RepeatedCompositeFieldContainer[_components_pb2.ActionResult]
    working_memory: _containers.MessageMap[str, WorkingMemoryItem]
    extra: _struct_pb2.Struct
    def __init__(self, room: _Optional[_Union[_environment_pb2.Room, _Mapping]] = ..., world: _Optional[_Union[_environment_pb2.World, _Mapping]] = ..., entity: _Optional[_Union[_environment_pb2.Entity, _Mapping]] = ..., providers: _Optional[_Mapping[str, ProviderCacheEntry]] = ..., action_plan: _Optional[_Union[ActionPlan, _Mapping]] = ..., action_results: _Optional[_Iterable[_Union[_components_pb2.ActionResult, _Mapping]]] = ..., working_memory: _Optional[_Mapping[str, WorkingMemoryItem]] = ..., extra: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class StateValues(_message.Message):
    __slots__ = ("agent_name", "action_names", "providers", "extra")
    AGENT_NAME_FIELD_NUMBER: _ClassVar[int]
    ACTION_NAMES_FIELD_NUMBER: _ClassVar[int]
    PROVIDERS_FIELD_NUMBER: _ClassVar[int]
    EXTRA_FIELD_NUMBER: _ClassVar[int]
    agent_name: str
    action_names: str
    providers: str
    extra: _struct_pb2.Struct
    def __init__(self, agent_name: _Optional[str] = ..., action_names: _Optional[str] = ..., providers: _Optional[str] = ..., extra: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class State(_message.Message):
    __slots__ = ("values", "data", "text", "extra")
    VALUES_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    EXTRA_FIELD_NUMBER: _ClassVar[int]
    values: StateValues
    data: StateData
    text: str
    extra: _struct_pb2.Struct
    def __init__(self, values: _Optional[_Union[StateValues, _Mapping]] = ..., data: _Optional[_Union[StateData, _Mapping]] = ..., text: _Optional[str] = ..., extra: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...
