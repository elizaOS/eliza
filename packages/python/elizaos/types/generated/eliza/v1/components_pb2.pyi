from eliza.v1 import primitives_pb2 as _primitives_pb2
from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ActionParameterSchema(_message.Message):
    __slots__ = ("type", "description", "default_value", "enum_values", "properties", "items", "minimum", "maximum", "pattern")
    class PropertiesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: ActionParameterSchema
        def __init__(self, key: _Optional[str] = ..., value: _Optional[_Union[ActionParameterSchema, _Mapping]] = ...) -> None: ...
    TYPE_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    DEFAULT_VALUE_FIELD_NUMBER: _ClassVar[int]
    ENUM_VALUES_FIELD_NUMBER: _ClassVar[int]
    PROPERTIES_FIELD_NUMBER: _ClassVar[int]
    ITEMS_FIELD_NUMBER: _ClassVar[int]
    MINIMUM_FIELD_NUMBER: _ClassVar[int]
    MAXIMUM_FIELD_NUMBER: _ClassVar[int]
    PATTERN_FIELD_NUMBER: _ClassVar[int]
    type: str
    description: str
    default_value: _struct_pb2.Value
    enum_values: _containers.RepeatedScalarFieldContainer[str]
    properties: _containers.MessageMap[str, ActionParameterSchema]
    items: ActionParameterSchema
    minimum: float
    maximum: float
    pattern: str
    def __init__(self, type: _Optional[str] = ..., description: _Optional[str] = ..., default_value: _Optional[_Union[_struct_pb2.Value, _Mapping]] = ..., enum_values: _Optional[_Iterable[str]] = ..., properties: _Optional[_Mapping[str, ActionParameterSchema]] = ..., items: _Optional[_Union[ActionParameterSchema, _Mapping]] = ..., minimum: _Optional[float] = ..., maximum: _Optional[float] = ..., pattern: _Optional[str] = ...) -> None: ...

class ActionParameter(_message.Message):
    __slots__ = ("name", "description", "required", "schema")
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    SCHEMA_FIELD_NUMBER: _ClassVar[int]
    name: str
    description: str
    required: bool
    schema: ActionParameterSchema
    def __init__(self, name: _Optional[str] = ..., description: _Optional[str] = ..., required: bool = ..., schema: _Optional[_Union[ActionParameterSchema, _Mapping]] = ...) -> None: ...

class ActionExample(_message.Message):
    __slots__ = ("name", "content")
    NAME_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    name: str
    content: _primitives_pb2.Content
    def __init__(self, name: _Optional[str] = ..., content: _Optional[_Union[_primitives_pb2.Content, _Mapping]] = ...) -> None: ...

class ActionParameters(_message.Message):
    __slots__ = ("values",)
    VALUES_FIELD_NUMBER: _ClassVar[int]
    values: _struct_pb2.Struct
    def __init__(self, values: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class ActionResult(_message.Message):
    __slots__ = ("success", "text", "values", "data", "error")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    VALUES_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    text: str
    values: _struct_pb2.Struct
    data: _struct_pb2.Struct
    error: str
    def __init__(self, success: bool = ..., text: _Optional[str] = ..., values: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., data: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., error: _Optional[str] = ...) -> None: ...

class ActionContext(_message.Message):
    __slots__ = ("previous_results",)
    PREVIOUS_RESULTS_FIELD_NUMBER: _ClassVar[int]
    previous_results: _containers.RepeatedCompositeFieldContainer[ActionResult]
    def __init__(self, previous_results: _Optional[_Iterable[_Union[ActionResult, _Mapping]]] = ...) -> None: ...

class HandlerOptions(_message.Message):
    __slots__ = ("action_context", "action_plan_json", "parameters")
    ACTION_CONTEXT_FIELD_NUMBER: _ClassVar[int]
    ACTION_PLAN_JSON_FIELD_NUMBER: _ClassVar[int]
    PARAMETERS_FIELD_NUMBER: _ClassVar[int]
    action_context: ActionContext
    action_plan_json: str
    parameters: ActionParameters
    def __init__(self, action_context: _Optional[_Union[ActionContext, _Mapping]] = ..., action_plan_json: _Optional[str] = ..., parameters: _Optional[_Union[ActionParameters, _Mapping]] = ...) -> None: ...

class ActionManifest(_message.Message):
    __slots__ = ("name", "description", "similes", "examples", "priority", "tags", "parameters")
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    SIMILES_FIELD_NUMBER: _ClassVar[int]
    EXAMPLES_FIELD_NUMBER: _ClassVar[int]
    PRIORITY_FIELD_NUMBER: _ClassVar[int]
    TAGS_FIELD_NUMBER: _ClassVar[int]
    PARAMETERS_FIELD_NUMBER: _ClassVar[int]
    name: str
    description: str
    similes: _containers.RepeatedScalarFieldContainer[str]
    examples: _containers.RepeatedCompositeFieldContainer[ActionExample]
    priority: int
    tags: _containers.RepeatedScalarFieldContainer[str]
    parameters: _containers.RepeatedCompositeFieldContainer[ActionParameter]
    def __init__(self, name: _Optional[str] = ..., description: _Optional[str] = ..., similes: _Optional[_Iterable[str]] = ..., examples: _Optional[_Iterable[_Union[ActionExample, _Mapping]]] = ..., priority: _Optional[int] = ..., tags: _Optional[_Iterable[str]] = ..., parameters: _Optional[_Iterable[_Union[ActionParameter, _Mapping]]] = ...) -> None: ...

class ProviderResult(_message.Message):
    __slots__ = ("text", "values", "data")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    VALUES_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    text: str
    values: _struct_pb2.Struct
    data: _struct_pb2.Struct
    def __init__(self, text: _Optional[str] = ..., values: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., data: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class ProviderManifest(_message.Message):
    __slots__ = ("name", "description", "dynamic", "position", "private")
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    DYNAMIC_FIELD_NUMBER: _ClassVar[int]
    POSITION_FIELD_NUMBER: _ClassVar[int]
    PRIVATE_FIELD_NUMBER: _ClassVar[int]
    name: str
    description: str
    dynamic: bool
    position: int
    private: bool
    def __init__(self, name: _Optional[str] = ..., description: _Optional[str] = ..., dynamic: bool = ..., position: _Optional[int] = ..., private: bool = ...) -> None: ...

class EvaluationExample(_message.Message):
    __slots__ = ("prompt", "messages", "outcome")
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    MESSAGES_FIELD_NUMBER: _ClassVar[int]
    OUTCOME_FIELD_NUMBER: _ClassVar[int]
    prompt: str
    messages: _containers.RepeatedCompositeFieldContainer[ActionExample]
    outcome: str
    def __init__(self, prompt: _Optional[str] = ..., messages: _Optional[_Iterable[_Union[ActionExample, _Mapping]]] = ..., outcome: _Optional[str] = ...) -> None: ...

class EvaluatorManifest(_message.Message):
    __slots__ = ("name", "description", "always_run", "similes", "examples")
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    ALWAYS_RUN_FIELD_NUMBER: _ClassVar[int]
    SIMILES_FIELD_NUMBER: _ClassVar[int]
    EXAMPLES_FIELD_NUMBER: _ClassVar[int]
    name: str
    description: str
    always_run: bool
    similes: _containers.RepeatedScalarFieldContainer[str]
    examples: _containers.RepeatedCompositeFieldContainer[EvaluationExample]
    def __init__(self, name: _Optional[str] = ..., description: _Optional[str] = ..., always_run: bool = ..., similes: _Optional[_Iterable[str]] = ..., examples: _Optional[_Iterable[_Union[EvaluationExample, _Mapping]]] = ...) -> None: ...
