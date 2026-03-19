from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class RuntimeSettings(_message.Message):
    __slots__ = ("values",)
    class ValuesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    VALUES_FIELD_NUMBER: _ClassVar[int]
    values: _containers.ScalarMap[str, str]
    def __init__(self, values: _Optional[_Mapping[str, str]] = ...) -> None: ...

class SettingDefinition(_message.Message):
    __slots__ = ("name", "description", "usage_description", "required", "public", "secret", "depends_on")
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    USAGE_DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    PUBLIC_FIELD_NUMBER: _ClassVar[int]
    SECRET_FIELD_NUMBER: _ClassVar[int]
    DEPENDS_ON_FIELD_NUMBER: _ClassVar[int]
    name: str
    description: str
    usage_description: str
    required: bool
    public: bool
    secret: bool
    depends_on: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, name: _Optional[str] = ..., description: _Optional[str] = ..., usage_description: _Optional[str] = ..., required: bool = ..., public: bool = ..., secret: bool = ..., depends_on: _Optional[_Iterable[str]] = ...) -> None: ...

class Setting(_message.Message):
    __slots__ = ("name", "description", "usage_description", "required", "public", "secret", "depends_on", "value")
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    USAGE_DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    PUBLIC_FIELD_NUMBER: _ClassVar[int]
    SECRET_FIELD_NUMBER: _ClassVar[int]
    DEPENDS_ON_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    name: str
    description: str
    usage_description: str
    required: bool
    public: bool
    secret: bool
    depends_on: _containers.RepeatedScalarFieldContainer[str]
    value: _struct_pb2.Value
    def __init__(self, name: _Optional[str] = ..., description: _Optional[str] = ..., usage_description: _Optional[str] = ..., required: bool = ..., public: bool = ..., secret: bool = ..., depends_on: _Optional[_Iterable[str]] = ..., value: _Optional[_Union[_struct_pb2.Value, _Mapping]] = ...) -> None: ...

class WorldSettings(_message.Message):
    __slots__ = ("settings",)
    class SettingsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: Setting
        def __init__(self, key: _Optional[str] = ..., value: _Optional[_Union[Setting, _Mapping]] = ...) -> None: ...
    SETTINGS_FIELD_NUMBER: _ClassVar[int]
    settings: _containers.MessageMap[str, Setting]
    def __init__(self, settings: _Optional[_Mapping[str, Setting]] = ...) -> None: ...

class OnboardingConfig(_message.Message):
    __slots__ = ("settings",)
    class SettingsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: SettingDefinition
        def __init__(self, key: _Optional[str] = ..., value: _Optional[_Union[SettingDefinition, _Mapping]] = ...) -> None: ...
    SETTINGS_FIELD_NUMBER: _ClassVar[int]
    settings: _containers.MessageMap[str, SettingDefinition]
    def __init__(self, settings: _Optional[_Mapping[str, SettingDefinition]] = ...) -> None: ...
