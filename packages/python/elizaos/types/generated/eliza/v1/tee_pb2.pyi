from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class TEEMode(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TEE_MODE_UNSPECIFIED: _ClassVar[TEEMode]
    TEE_MODE_OFF: _ClassVar[TEEMode]
    TEE_MODE_LOCAL: _ClassVar[TEEMode]
    TEE_MODE_DOCKER: _ClassVar[TEEMode]
    TEE_MODE_PRODUCTION: _ClassVar[TEEMode]

class TeeType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TEE_TYPE_UNSPECIFIED: _ClassVar[TeeType]
    TEE_TYPE_TDX_DSTACK: _ClassVar[TeeType]
TEE_MODE_UNSPECIFIED: TEEMode
TEE_MODE_OFF: TEEMode
TEE_MODE_LOCAL: TEEMode
TEE_MODE_DOCKER: TEEMode
TEE_MODE_PRODUCTION: TEEMode
TEE_TYPE_UNSPECIFIED: TeeType
TEE_TYPE_TDX_DSTACK: TeeType

class TeeAgent(_message.Message):
    __slots__ = ("id", "agent_id", "agent_name", "created_at", "public_key", "attestation")
    ID_FIELD_NUMBER: _ClassVar[int]
    AGENT_ID_FIELD_NUMBER: _ClassVar[int]
    AGENT_NAME_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    PUBLIC_KEY_FIELD_NUMBER: _ClassVar[int]
    ATTESTATION_FIELD_NUMBER: _ClassVar[int]
    id: str
    agent_id: str
    agent_name: str
    created_at: int
    public_key: str
    attestation: str
    def __init__(self, id: _Optional[str] = ..., agent_id: _Optional[str] = ..., agent_name: _Optional[str] = ..., created_at: _Optional[int] = ..., public_key: _Optional[str] = ..., attestation: _Optional[str] = ...) -> None: ...

class RemoteAttestationQuote(_message.Message):
    __slots__ = ("quote", "timestamp")
    QUOTE_FIELD_NUMBER: _ClassVar[int]
    TIMESTAMP_FIELD_NUMBER: _ClassVar[int]
    quote: str
    timestamp: int
    def __init__(self, quote: _Optional[str] = ..., timestamp: _Optional[int] = ...) -> None: ...

class DeriveKeyAttestationData(_message.Message):
    __slots__ = ("agent_id", "public_key", "subject")
    AGENT_ID_FIELD_NUMBER: _ClassVar[int]
    PUBLIC_KEY_FIELD_NUMBER: _ClassVar[int]
    SUBJECT_FIELD_NUMBER: _ClassVar[int]
    agent_id: str
    public_key: str
    subject: str
    def __init__(self, agent_id: _Optional[str] = ..., public_key: _Optional[str] = ..., subject: _Optional[str] = ...) -> None: ...

class AttestedMessage(_message.Message):
    __slots__ = ("entity_id", "room_id", "content")
    ENTITY_ID_FIELD_NUMBER: _ClassVar[int]
    ROOM_ID_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    entity_id: str
    room_id: str
    content: str
    def __init__(self, entity_id: _Optional[str] = ..., room_id: _Optional[str] = ..., content: _Optional[str] = ...) -> None: ...

class RemoteAttestationMessage(_message.Message):
    __slots__ = ("agent_id", "timestamp", "message")
    AGENT_ID_FIELD_NUMBER: _ClassVar[int]
    TIMESTAMP_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    agent_id: str
    timestamp: int
    message: AttestedMessage
    def __init__(self, agent_id: _Optional[str] = ..., timestamp: _Optional[int] = ..., message: _Optional[_Union[AttestedMessage, _Mapping]] = ...) -> None: ...

class TeePluginConfig(_message.Message):
    __slots__ = ("vendor", "vendor_config")
    VENDOR_FIELD_NUMBER: _ClassVar[int]
    VENDOR_CONFIG_FIELD_NUMBER: _ClassVar[int]
    vendor: str
    vendor_config: _struct_pb2.Struct
    def __init__(self, vendor: _Optional[str] = ..., vendor_config: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...
