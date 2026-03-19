from eliza.v1 import memory_pb2 as _memory_pb2
from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf import timestamp_pb2 as _timestamp_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class DbRunStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    DB_RUN_STATUS_UNSPECIFIED: _ClassVar[DbRunStatus]
    DB_RUN_STATUS_STARTED: _ClassVar[DbRunStatus]
    DB_RUN_STATUS_COMPLETED: _ClassVar[DbRunStatus]
    DB_RUN_STATUS_TIMEOUT: _ClassVar[DbRunStatus]
    DB_RUN_STATUS_ERROR: _ClassVar[DbRunStatus]

class VectorDimension(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    VECTOR_DIMENSION_UNSPECIFIED: _ClassVar[VectorDimension]
    VECTOR_DIMENSION_SMALL: _ClassVar[VectorDimension]
    VECTOR_DIMENSION_MEDIUM: _ClassVar[VectorDimension]
    VECTOR_DIMENSION_LARGE: _ClassVar[VectorDimension]
    VECTOR_DIMENSION_XL: _ClassVar[VectorDimension]
    VECTOR_DIMENSION_XXL: _ClassVar[VectorDimension]
    VECTOR_DIMENSION_XXXL: _ClassVar[VectorDimension]
DB_RUN_STATUS_UNSPECIFIED: DbRunStatus
DB_RUN_STATUS_STARTED: DbRunStatus
DB_RUN_STATUS_COMPLETED: DbRunStatus
DB_RUN_STATUS_TIMEOUT: DbRunStatus
DB_RUN_STATUS_ERROR: DbRunStatus
VECTOR_DIMENSION_UNSPECIFIED: VectorDimension
VECTOR_DIMENSION_SMALL: VectorDimension
VECTOR_DIMENSION_MEDIUM: VectorDimension
VECTOR_DIMENSION_LARGE: VectorDimension
VECTOR_DIMENSION_XL: VectorDimension
VECTOR_DIMENSION_XXL: VectorDimension
VECTOR_DIMENSION_XXXL: VectorDimension

class BaseLogBody(_message.Message):
    __slots__ = ("run_id", "parent_run_id", "status", "message_id", "room_id", "entity_id", "metadata")
    RUN_ID_FIELD_NUMBER: _ClassVar[int]
    PARENT_RUN_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    ROOM_ID_FIELD_NUMBER: _ClassVar[int]
    ENTITY_ID_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    run_id: str
    parent_run_id: str
    status: str
    message_id: str
    room_id: str
    entity_id: str
    metadata: _struct_pb2.Struct
    def __init__(self, run_id: _Optional[str] = ..., parent_run_id: _Optional[str] = ..., status: _Optional[str] = ..., message_id: _Optional[str] = ..., room_id: _Optional[str] = ..., entity_id: _Optional[str] = ..., metadata: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class ActionLogContent(_message.Message):
    __slots__ = ("actions", "text", "thought")
    ACTIONS_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    THOUGHT_FIELD_NUMBER: _ClassVar[int]
    actions: _containers.RepeatedScalarFieldContainer[str]
    text: str
    thought: str
    def __init__(self, actions: _Optional[_Iterable[str]] = ..., text: _Optional[str] = ..., thought: _Optional[str] = ...) -> None: ...

class ActionLogResult(_message.Message):
    __slots__ = ("success", "data", "text", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    data: _struct_pb2.Struct
    text: str
    error: str
    def __init__(self, success: bool = ..., data: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., text: _Optional[str] = ..., error: _Optional[str] = ...) -> None: ...

class ActionLogPrompt(_message.Message):
    __slots__ = ("model_type", "prompt", "timestamp")
    MODEL_TYPE_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    TIMESTAMP_FIELD_NUMBER: _ClassVar[int]
    model_type: str
    prompt: str
    timestamp: int
    def __init__(self, model_type: _Optional[str] = ..., prompt: _Optional[str] = ..., timestamp: _Optional[int] = ...) -> None: ...

class ActionLogBody(_message.Message):
    __slots__ = ("base", "action", "action_id", "message", "state", "responses", "content", "result", "prompts", "prompt_count", "plan_step", "plan_thought")
    BASE_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    ACTION_ID_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    RESPONSES_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    RESULT_FIELD_NUMBER: _ClassVar[int]
    PROMPTS_FIELD_NUMBER: _ClassVar[int]
    PROMPT_COUNT_FIELD_NUMBER: _ClassVar[int]
    PLAN_STEP_FIELD_NUMBER: _ClassVar[int]
    PLAN_THOUGHT_FIELD_NUMBER: _ClassVar[int]
    base: BaseLogBody
    action: str
    action_id: str
    message: str
    state: _struct_pb2.Struct
    responses: _containers.RepeatedCompositeFieldContainer[_struct_pb2.Struct]
    content: ActionLogContent
    result: ActionLogResult
    prompts: _containers.RepeatedCompositeFieldContainer[ActionLogPrompt]
    prompt_count: int
    plan_step: str
    plan_thought: str
    def __init__(self, base: _Optional[_Union[BaseLogBody, _Mapping]] = ..., action: _Optional[str] = ..., action_id: _Optional[str] = ..., message: _Optional[str] = ..., state: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., responses: _Optional[_Iterable[_Union[_struct_pb2.Struct, _Mapping]]] = ..., content: _Optional[_Union[ActionLogContent, _Mapping]] = ..., result: _Optional[_Union[ActionLogResult, _Mapping]] = ..., prompts: _Optional[_Iterable[_Union[ActionLogPrompt, _Mapping]]] = ..., prompt_count: _Optional[int] = ..., plan_step: _Optional[str] = ..., plan_thought: _Optional[str] = ...) -> None: ...

class EvaluatorLogBody(_message.Message):
    __slots__ = ("base", "evaluator", "message", "state")
    BASE_FIELD_NUMBER: _ClassVar[int]
    EVALUATOR_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    base: BaseLogBody
    evaluator: str
    message: str
    state: _struct_pb2.Struct
    def __init__(self, base: _Optional[_Union[BaseLogBody, _Mapping]] = ..., evaluator: _Optional[str] = ..., message: _Optional[str] = ..., state: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class ModelActionContext(_message.Message):
    __slots__ = ("action_name", "action_id")
    ACTION_NAME_FIELD_NUMBER: _ClassVar[int]
    ACTION_ID_FIELD_NUMBER: _ClassVar[int]
    action_name: str
    action_id: str
    def __init__(self, action_name: _Optional[str] = ..., action_id: _Optional[str] = ...) -> None: ...

class ModelLogBody(_message.Message):
    __slots__ = ("base", "model_type", "model_key", "params", "prompt", "system_prompt", "timestamp", "execution_time", "provider", "action_context", "response")
    BASE_FIELD_NUMBER: _ClassVar[int]
    MODEL_TYPE_FIELD_NUMBER: _ClassVar[int]
    MODEL_KEY_FIELD_NUMBER: _ClassVar[int]
    PARAMS_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    SYSTEM_PROMPT_FIELD_NUMBER: _ClassVar[int]
    TIMESTAMP_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_TIME_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    ACTION_CONTEXT_FIELD_NUMBER: _ClassVar[int]
    RESPONSE_FIELD_NUMBER: _ClassVar[int]
    base: BaseLogBody
    model_type: str
    model_key: str
    params: _struct_pb2.Struct
    prompt: str
    system_prompt: str
    timestamp: int
    execution_time: int
    provider: str
    action_context: ModelActionContext
    response: _struct_pb2.Value
    def __init__(self, base: _Optional[_Union[BaseLogBody, _Mapping]] = ..., model_type: _Optional[str] = ..., model_key: _Optional[str] = ..., params: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., prompt: _Optional[str] = ..., system_prompt: _Optional[str] = ..., timestamp: _Optional[int] = ..., execution_time: _Optional[int] = ..., provider: _Optional[str] = ..., action_context: _Optional[_Union[ModelActionContext, _Mapping]] = ..., response: _Optional[_Union[_struct_pb2.Value, _Mapping]] = ...) -> None: ...

class EmbeddingLogBody(_message.Message):
    __slots__ = ("base", "memory_id", "duration")
    BASE_FIELD_NUMBER: _ClassVar[int]
    MEMORY_ID_FIELD_NUMBER: _ClassVar[int]
    DURATION_FIELD_NUMBER: _ClassVar[int]
    base: BaseLogBody
    memory_id: str
    duration: int
    def __init__(self, base: _Optional[_Union[BaseLogBody, _Mapping]] = ..., memory_id: _Optional[str] = ..., duration: _Optional[int] = ...) -> None: ...

class LogBody(_message.Message):
    __slots__ = ("base", "action", "evaluator", "model", "embedding")
    BASE_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    EVALUATOR_FIELD_NUMBER: _ClassVar[int]
    MODEL_FIELD_NUMBER: _ClassVar[int]
    EMBEDDING_FIELD_NUMBER: _ClassVar[int]
    base: BaseLogBody
    action: ActionLogBody
    evaluator: EvaluatorLogBody
    model: ModelLogBody
    embedding: EmbeddingLogBody
    def __init__(self, base: _Optional[_Union[BaseLogBody, _Mapping]] = ..., action: _Optional[_Union[ActionLogBody, _Mapping]] = ..., evaluator: _Optional[_Union[EvaluatorLogBody, _Mapping]] = ..., model: _Optional[_Union[ModelLogBody, _Mapping]] = ..., embedding: _Optional[_Union[EmbeddingLogBody, _Mapping]] = ...) -> None: ...

class Log(_message.Message):
    __slots__ = ("id", "entity_id", "room_id", "body", "type", "created_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    ENTITY_ID_FIELD_NUMBER: _ClassVar[int]
    ROOM_ID_FIELD_NUMBER: _ClassVar[int]
    BODY_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    entity_id: str
    room_id: str
    body: LogBody
    type: str
    created_at: _timestamp_pb2.Timestamp
    def __init__(self, id: _Optional[str] = ..., entity_id: _Optional[str] = ..., room_id: _Optional[str] = ..., body: _Optional[_Union[LogBody, _Mapping]] = ..., type: _Optional[str] = ..., created_at: _Optional[_Union[_timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class AgentRunCounts(_message.Message):
    __slots__ = ("actions", "model_calls", "errors", "evaluators")
    ACTIONS_FIELD_NUMBER: _ClassVar[int]
    MODEL_CALLS_FIELD_NUMBER: _ClassVar[int]
    ERRORS_FIELD_NUMBER: _ClassVar[int]
    EVALUATORS_FIELD_NUMBER: _ClassVar[int]
    actions: int
    model_calls: int
    errors: int
    evaluators: int
    def __init__(self, actions: _Optional[int] = ..., model_calls: _Optional[int] = ..., errors: _Optional[int] = ..., evaluators: _Optional[int] = ...) -> None: ...

class AgentRunSummary(_message.Message):
    __slots__ = ("run_id", "status", "started_at", "ended_at", "duration_ms", "message_id", "room_id", "entity_id", "metadata", "counts")
    RUN_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    STARTED_AT_FIELD_NUMBER: _ClassVar[int]
    ENDED_AT_FIELD_NUMBER: _ClassVar[int]
    DURATION_MS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    ROOM_ID_FIELD_NUMBER: _ClassVar[int]
    ENTITY_ID_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    COUNTS_FIELD_NUMBER: _ClassVar[int]
    run_id: str
    status: DbRunStatus
    started_at: int
    ended_at: int
    duration_ms: int
    message_id: str
    room_id: str
    entity_id: str
    metadata: _struct_pb2.Struct
    counts: AgentRunCounts
    def __init__(self, run_id: _Optional[str] = ..., status: _Optional[_Union[DbRunStatus, str]] = ..., started_at: _Optional[int] = ..., ended_at: _Optional[int] = ..., duration_ms: _Optional[int] = ..., message_id: _Optional[str] = ..., room_id: _Optional[str] = ..., entity_id: _Optional[str] = ..., metadata: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., counts: _Optional[_Union[AgentRunCounts, _Mapping]] = ...) -> None: ...

class AgentRunSummaryResult(_message.Message):
    __slots__ = ("runs", "total", "has_more")
    RUNS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    HAS_MORE_FIELD_NUMBER: _ClassVar[int]
    runs: _containers.RepeatedCompositeFieldContainer[AgentRunSummary]
    total: int
    has_more: bool
    def __init__(self, runs: _Optional[_Iterable[_Union[AgentRunSummary, _Mapping]]] = ..., total: _Optional[int] = ..., has_more: bool = ...) -> None: ...

class EmbeddingSearchResult(_message.Message):
    __slots__ = ("embedding", "levenshtein_score")
    EMBEDDING_FIELD_NUMBER: _ClassVar[int]
    LEVENSHTEIN_SCORE_FIELD_NUMBER: _ClassVar[int]
    embedding: _containers.RepeatedScalarFieldContainer[float]
    levenshtein_score: int
    def __init__(self, embedding: _Optional[_Iterable[float]] = ..., levenshtein_score: _Optional[int] = ...) -> None: ...

class MemoryRetrievalOptions(_message.Message):
    __slots__ = ("room_id", "count", "unique", "start", "end", "agent_id")
    ROOM_ID_FIELD_NUMBER: _ClassVar[int]
    COUNT_FIELD_NUMBER: _ClassVar[int]
    UNIQUE_FIELD_NUMBER: _ClassVar[int]
    START_FIELD_NUMBER: _ClassVar[int]
    END_FIELD_NUMBER: _ClassVar[int]
    AGENT_ID_FIELD_NUMBER: _ClassVar[int]
    room_id: str
    count: int
    unique: bool
    start: int
    end: int
    agent_id: str
    def __init__(self, room_id: _Optional[str] = ..., count: _Optional[int] = ..., unique: bool = ..., start: _Optional[int] = ..., end: _Optional[int] = ..., agent_id: _Optional[str] = ...) -> None: ...

class MemorySearchOptions(_message.Message):
    __slots__ = ("embedding", "match_threshold", "count", "room_id", "agent_id", "unique", "metadata")
    EMBEDDING_FIELD_NUMBER: _ClassVar[int]
    MATCH_THRESHOLD_FIELD_NUMBER: _ClassVar[int]
    COUNT_FIELD_NUMBER: _ClassVar[int]
    ROOM_ID_FIELD_NUMBER: _ClassVar[int]
    AGENT_ID_FIELD_NUMBER: _ClassVar[int]
    UNIQUE_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    embedding: _containers.RepeatedScalarFieldContainer[float]
    match_threshold: float
    count: int
    room_id: str
    agent_id: str
    unique: bool
    metadata: _memory_pb2.MemoryMetadata
    def __init__(self, embedding: _Optional[_Iterable[float]] = ..., match_threshold: _Optional[float] = ..., count: _Optional[int] = ..., room_id: _Optional[str] = ..., agent_id: _Optional[str] = ..., unique: bool = ..., metadata: _Optional[_Union[_memory_pb2.MemoryMetadata, _Mapping]] = ...) -> None: ...

class MultiRoomMemoryOptions(_message.Message):
    __slots__ = ("room_ids", "limit", "agent_id")
    ROOM_IDS_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    AGENT_ID_FIELD_NUMBER: _ClassVar[int]
    room_ids: _containers.RepeatedScalarFieldContainer[str]
    limit: int
    agent_id: str
    def __init__(self, room_ids: _Optional[_Iterable[str]] = ..., limit: _Optional[int] = ..., agent_id: _Optional[str] = ...) -> None: ...
