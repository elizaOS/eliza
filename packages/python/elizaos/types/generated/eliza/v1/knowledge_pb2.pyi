from eliza.v1 import memory_pb2 as _memory_pb2
from eliza.v1 import primitives_pb2 as _primitives_pb2
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class KnowledgeRecord(_message.Message):
    __slots__ = ("id", "content", "metadata")
    ID_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    id: str
    content: _primitives_pb2.Content
    metadata: _memory_pb2.MemoryMetadata
    def __init__(self, id: _Optional[str] = ..., content: _Optional[_Union[_primitives_pb2.Content, _Mapping]] = ..., metadata: _Optional[_Union[_memory_pb2.MemoryMetadata, _Mapping]] = ...) -> None: ...

class DirectoryItem(_message.Message):
    __slots__ = ("directory", "shared")
    DIRECTORY_FIELD_NUMBER: _ClassVar[int]
    SHARED_FIELD_NUMBER: _ClassVar[int]
    directory: str
    shared: bool
    def __init__(self, directory: _Optional[str] = ..., shared: bool = ...) -> None: ...
