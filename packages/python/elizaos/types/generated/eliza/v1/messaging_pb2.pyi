from eliza.v1 import memory_pb2 as _memory_pb2
from eliza.v1 import primitives_pb2 as _primitives_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class SocketMessageType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SOCKET_MESSAGE_TYPE_UNSPECIFIED: _ClassVar[SocketMessageType]
    SOCKET_MESSAGE_TYPE_ROOM_JOINING: _ClassVar[SocketMessageType]
    SOCKET_MESSAGE_TYPE_SEND_MESSAGE: _ClassVar[SocketMessageType]
    SOCKET_MESSAGE_TYPE_MESSAGE: _ClassVar[SocketMessageType]
    SOCKET_MESSAGE_TYPE_ACK: _ClassVar[SocketMessageType]
    SOCKET_MESSAGE_TYPE_THINKING: _ClassVar[SocketMessageType]
    SOCKET_MESSAGE_TYPE_CONTROL: _ClassVar[SocketMessageType]
SOCKET_MESSAGE_TYPE_UNSPECIFIED: SocketMessageType
SOCKET_MESSAGE_TYPE_ROOM_JOINING: SocketMessageType
SOCKET_MESSAGE_TYPE_SEND_MESSAGE: SocketMessageType
SOCKET_MESSAGE_TYPE_MESSAGE: SocketMessageType
SOCKET_MESSAGE_TYPE_ACK: SocketMessageType
SOCKET_MESSAGE_TYPE_THINKING: SocketMessageType
SOCKET_MESSAGE_TYPE_CONTROL: SocketMessageType

class TargetInfo(_message.Message):
    __slots__ = ("source", "room_id", "channel_id", "server_id", "entity_id", "thread_id")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    ROOM_ID_FIELD_NUMBER: _ClassVar[int]
    CHANNEL_ID_FIELD_NUMBER: _ClassVar[int]
    SERVER_ID_FIELD_NUMBER: _ClassVar[int]
    ENTITY_ID_FIELD_NUMBER: _ClassVar[int]
    THREAD_ID_FIELD_NUMBER: _ClassVar[int]
    source: str
    room_id: str
    channel_id: str
    server_id: str
    entity_id: str
    thread_id: str
    def __init__(self, source: _Optional[str] = ..., room_id: _Optional[str] = ..., channel_id: _Optional[str] = ..., server_id: _Optional[str] = ..., entity_id: _Optional[str] = ..., thread_id: _Optional[str] = ...) -> None: ...

class MessageStreamChunkPayload(_message.Message):
    __slots__ = ("message_id", "chunk", "index", "channel_id", "agent_id")
    MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    CHUNK_FIELD_NUMBER: _ClassVar[int]
    INDEX_FIELD_NUMBER: _ClassVar[int]
    CHANNEL_ID_FIELD_NUMBER: _ClassVar[int]
    AGENT_ID_FIELD_NUMBER: _ClassVar[int]
    message_id: str
    chunk: str
    index: int
    channel_id: str
    agent_id: str
    def __init__(self, message_id: _Optional[str] = ..., chunk: _Optional[str] = ..., index: _Optional[int] = ..., channel_id: _Optional[str] = ..., agent_id: _Optional[str] = ...) -> None: ...

class MessageStreamErrorPayload(_message.Message):
    __slots__ = ("message_id", "channel_id", "agent_id", "error", "partial_text")
    MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    CHANNEL_ID_FIELD_NUMBER: _ClassVar[int]
    AGENT_ID_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    PARTIAL_TEXT_FIELD_NUMBER: _ClassVar[int]
    message_id: str
    channel_id: str
    agent_id: str
    error: str
    partial_text: str
    def __init__(self, message_id: _Optional[str] = ..., channel_id: _Optional[str] = ..., agent_id: _Optional[str] = ..., error: _Optional[str] = ..., partial_text: _Optional[str] = ...) -> None: ...

class MessageHandlerOptions(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class MessageResult(_message.Message):
    __slots__ = ("message_id", "user_message", "agent_responses", "usage")
    MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    USER_MESSAGE_FIELD_NUMBER: _ClassVar[int]
    AGENT_RESPONSES_FIELD_NUMBER: _ClassVar[int]
    USAGE_FIELD_NUMBER: _ClassVar[int]
    message_id: str
    user_message: _memory_pb2.Memory
    agent_responses: _containers.RepeatedCompositeFieldContainer[_primitives_pb2.Content]
    usage: MessageUsage
    def __init__(self, message_id: _Optional[str] = ..., user_message: _Optional[_Union[_memory_pb2.Memory, _Mapping]] = ..., agent_responses: _Optional[_Iterable[_Union[_primitives_pb2.Content, _Mapping]]] = ..., usage: _Optional[_Union[MessageUsage, _Mapping]] = ...) -> None: ...

class MessageUsage(_message.Message):
    __slots__ = ("input_tokens", "output_tokens", "model")
    INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    MODEL_FIELD_NUMBER: _ClassVar[int]
    input_tokens: int
    output_tokens: int
    model: str
    def __init__(self, input_tokens: _Optional[int] = ..., output_tokens: _Optional[int] = ..., model: _Optional[str] = ...) -> None: ...
