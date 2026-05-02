from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ServiceType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SERVICE_TYPE_UNSPECIFIED: _ClassVar[ServiceType]
    SERVICE_TYPE_TRANSCRIPTION: _ClassVar[ServiceType]
    SERVICE_TYPE_VIDEO: _ClassVar[ServiceType]
    SERVICE_TYPE_BROWSER: _ClassVar[ServiceType]
    SERVICE_TYPE_PDF: _ClassVar[ServiceType]
    SERVICE_TYPE_REMOTE_FILES: _ClassVar[ServiceType]
    SERVICE_TYPE_WEB_SEARCH: _ClassVar[ServiceType]
    SERVICE_TYPE_EMAIL: _ClassVar[ServiceType]
    SERVICE_TYPE_TEE: _ClassVar[ServiceType]
    SERVICE_TYPE_TASK: _ClassVar[ServiceType]
    SERVICE_TYPE_WALLET: _ClassVar[ServiceType]
    SERVICE_TYPE_LP_POOL: _ClassVar[ServiceType]
    SERVICE_TYPE_TOKEN_DATA: _ClassVar[ServiceType]
    SERVICE_TYPE_MESSAGE_SERVICE: _ClassVar[ServiceType]
    SERVICE_TYPE_MESSAGE: _ClassVar[ServiceType]
    SERVICE_TYPE_POST: _ClassVar[ServiceType]
    SERVICE_TYPE_UNKNOWN: _ClassVar[ServiceType]
SERVICE_TYPE_UNSPECIFIED: ServiceType
SERVICE_TYPE_TRANSCRIPTION: ServiceType
SERVICE_TYPE_VIDEO: ServiceType
SERVICE_TYPE_BROWSER: ServiceType
SERVICE_TYPE_PDF: ServiceType
SERVICE_TYPE_REMOTE_FILES: ServiceType
SERVICE_TYPE_WEB_SEARCH: ServiceType
SERVICE_TYPE_EMAIL: ServiceType
SERVICE_TYPE_TEE: ServiceType
SERVICE_TYPE_TASK: ServiceType
SERVICE_TYPE_WALLET: ServiceType
SERVICE_TYPE_LP_POOL: ServiceType
SERVICE_TYPE_TOKEN_DATA: ServiceType
SERVICE_TYPE_MESSAGE_SERVICE: ServiceType
SERVICE_TYPE_MESSAGE: ServiceType
SERVICE_TYPE_POST: ServiceType
SERVICE_TYPE_UNKNOWN: ServiceType

class ServiceManifest(_message.Message):
    __slots__ = ("type", "description", "capability_description", "config")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    CAPABILITY_DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    CONFIG_FIELD_NUMBER: _ClassVar[int]
    type: ServiceType
    description: str
    capability_description: str
    config: _struct_pb2.Struct
    def __init__(self, type: _Optional[_Union[ServiceType, str]] = ..., description: _Optional[str] = ..., capability_description: _Optional[str] = ..., config: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class ServiceError(_message.Message):
    __slots__ = ("code", "message", "details", "cause")
    CODE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    DETAILS_FIELD_NUMBER: _ClassVar[int]
    CAUSE_FIELD_NUMBER: _ClassVar[int]
    code: str
    message: str
    details: _struct_pb2.Struct
    cause: str
    def __init__(self, code: _Optional[str] = ..., message: _Optional[str] = ..., details: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., cause: _Optional[str] = ...) -> None: ...
