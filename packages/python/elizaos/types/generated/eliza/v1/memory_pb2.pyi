from eliza.v1 import primitives_pb2 as _primitives_pb2
from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class BaseMetadata(_message.Message):
    __slots__ = ("type", "source", "source_id", "scope", "timestamp", "tags")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    SOURCE_ID_FIELD_NUMBER: _ClassVar[int]
    SCOPE_FIELD_NUMBER: _ClassVar[int]
    TIMESTAMP_FIELD_NUMBER: _ClassVar[int]
    TAGS_FIELD_NUMBER: _ClassVar[int]
    type: str
    source: str
    source_id: str
    scope: str
    timestamp: int
    tags: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, type: _Optional[str] = ..., source: _Optional[str] = ..., source_id: _Optional[str] = ..., scope: _Optional[str] = ..., timestamp: _Optional[int] = ..., tags: _Optional[_Iterable[str]] = ...) -> None: ...

class DocumentMetadata(_message.Message):
    __slots__ = ("base",)
    BASE_FIELD_NUMBER: _ClassVar[int]
    base: BaseMetadata
    def __init__(self, base: _Optional[_Union[BaseMetadata, _Mapping]] = ...) -> None: ...

class FragmentMetadata(_message.Message):
    __slots__ = ("base", "document_id", "position")
    BASE_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    POSITION_FIELD_NUMBER: _ClassVar[int]
    base: BaseMetadata
    document_id: str
    position: int
    def __init__(self, base: _Optional[_Union[BaseMetadata, _Mapping]] = ..., document_id: _Optional[str] = ..., position: _Optional[int] = ...) -> None: ...

class MessageMetadata(_message.Message):
    __slots__ = ("base", "trajectory_step_id", "benchmark_context")
    BASE_FIELD_NUMBER: _ClassVar[int]
    TRAJECTORY_STEP_ID_FIELD_NUMBER: _ClassVar[int]
    BENCHMARK_CONTEXT_FIELD_NUMBER: _ClassVar[int]
    base: BaseMetadata
    trajectory_step_id: str
    benchmark_context: str
    def __init__(self, base: _Optional[_Union[BaseMetadata, _Mapping]] = ..., trajectory_step_id: _Optional[str] = ..., benchmark_context: _Optional[str] = ...) -> None: ...

class DescriptionMetadata(_message.Message):
    __slots__ = ("base",)
    BASE_FIELD_NUMBER: _ClassVar[int]
    base: BaseMetadata
    def __init__(self, base: _Optional[_Union[BaseMetadata, _Mapping]] = ...) -> None: ...

class CustomMetadata(_message.Message):
    __slots__ = ("base", "custom_data")
    BASE_FIELD_NUMBER: _ClassVar[int]
    CUSTOM_DATA_FIELD_NUMBER: _ClassVar[int]
    base: BaseMetadata
    custom_data: _struct_pb2.Struct
    def __init__(self, base: _Optional[_Union[BaseMetadata, _Mapping]] = ..., custom_data: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class MemoryMetadata(_message.Message):
    __slots__ = ("document", "fragment", "message", "description", "custom")
    DOCUMENT_FIELD_NUMBER: _ClassVar[int]
    FRAGMENT_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    CUSTOM_FIELD_NUMBER: _ClassVar[int]
    document: DocumentMetadata
    fragment: FragmentMetadata
    message: MessageMetadata
    description: DescriptionMetadata
    custom: CustomMetadata
    def __init__(self, document: _Optional[_Union[DocumentMetadata, _Mapping]] = ..., fragment: _Optional[_Union[FragmentMetadata, _Mapping]] = ..., message: _Optional[_Union[MessageMetadata, _Mapping]] = ..., description: _Optional[_Union[DescriptionMetadata, _Mapping]] = ..., custom: _Optional[_Union[CustomMetadata, _Mapping]] = ...) -> None: ...

class Memory(_message.Message):
    __slots__ = ("id", "entity_id", "agent_id", "created_at", "content", "embedding", "room_id", "world_id", "unique", "similarity", "metadata")
    ID_FIELD_NUMBER: _ClassVar[int]
    ENTITY_ID_FIELD_NUMBER: _ClassVar[int]
    AGENT_ID_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    EMBEDDING_FIELD_NUMBER: _ClassVar[int]
    ROOM_ID_FIELD_NUMBER: _ClassVar[int]
    WORLD_ID_FIELD_NUMBER: _ClassVar[int]
    UNIQUE_FIELD_NUMBER: _ClassVar[int]
    SIMILARITY_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    id: str
    entity_id: str
    agent_id: str
    created_at: int
    content: _primitives_pb2.Content
    embedding: _containers.RepeatedScalarFieldContainer[float]
    room_id: str
    world_id: str
    unique: bool
    similarity: float
    metadata: MemoryMetadata
    def __init__(self, id: _Optional[str] = ..., entity_id: _Optional[str] = ..., agent_id: _Optional[str] = ..., created_at: _Optional[int] = ..., content: _Optional[_Union[_primitives_pb2.Content, _Mapping]] = ..., embedding: _Optional[_Iterable[float]] = ..., room_id: _Optional[str] = ..., world_id: _Optional[str] = ..., unique: bool = ..., similarity: _Optional[float] = ..., metadata: _Optional[_Union[MemoryMetadata, _Mapping]] = ...) -> None: ...

class MessageMemory(_message.Message):
    __slots__ = ("memory",)
    MEMORY_FIELD_NUMBER: _ClassVar[int]
    memory: Memory
    def __init__(self, memory: _Optional[_Union[Memory, _Mapping]] = ...) -> None: ...
