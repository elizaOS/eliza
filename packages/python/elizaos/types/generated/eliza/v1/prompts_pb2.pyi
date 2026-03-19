from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class PromptFieldInfo(_message.Message):
    __slots__ = ("id", "type", "label", "description", "criteria")
    ID_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    LABEL_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    CRITERIA_FIELD_NUMBER: _ClassVar[int]
    id: str
    type: str
    label: str
    description: str
    criteria: str
    def __init__(self, id: _Optional[str] = ..., type: _Optional[str] = ..., label: _Optional[str] = ..., description: _Optional[str] = ..., criteria: _Optional[str] = ...) -> None: ...

class BuildPromptOptions(_message.Message):
    __slots__ = ("template", "state", "defaults")
    class DefaultsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    TEMPLATE_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    DEFAULTS_FIELD_NUMBER: _ClassVar[int]
    template: str
    state: _struct_pb2.Struct
    defaults: _containers.ScalarMap[str, str]
    def __init__(self, template: _Optional[str] = ..., state: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., defaults: _Optional[_Mapping[str, str]] = ...) -> None: ...

class BuiltPrompt(_message.Message):
    __slots__ = ("prompt", "system", "substituted_variables", "missing_variables")
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    SYSTEM_FIELD_NUMBER: _ClassVar[int]
    SUBSTITUTED_VARIABLES_FIELD_NUMBER: _ClassVar[int]
    MISSING_VARIABLES_FIELD_NUMBER: _ClassVar[int]
    prompt: str
    system: str
    substituted_variables: _containers.RepeatedScalarFieldContainer[str]
    missing_variables: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, prompt: _Optional[str] = ..., system: _Optional[str] = ..., substituted_variables: _Optional[_Iterable[str]] = ..., missing_variables: _Optional[_Iterable[str]] = ...) -> None: ...

class PromptTemplateConfig(_message.Message):
    __slots__ = ("template", "name", "description", "defaults", "required_variables", "optional_variables")
    class DefaultsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    TEMPLATE_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    DEFAULTS_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_VARIABLES_FIELD_NUMBER: _ClassVar[int]
    OPTIONAL_VARIABLES_FIELD_NUMBER: _ClassVar[int]
    template: str
    name: str
    description: str
    defaults: _containers.ScalarMap[str, str]
    required_variables: _containers.RepeatedScalarFieldContainer[str]
    optional_variables: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, template: _Optional[str] = ..., name: _Optional[str] = ..., description: _Optional[str] = ..., defaults: _Optional[_Mapping[str, str]] = ..., required_variables: _Optional[_Iterable[str]] = ..., optional_variables: _Optional[_Iterable[str]] = ...) -> None: ...
