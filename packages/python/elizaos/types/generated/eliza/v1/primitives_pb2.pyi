from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class UUID(_message.Message):
    __slots__ = ("value",)
    VALUE_FIELD_NUMBER: _ClassVar[int]
    value: str
    def __init__(self, value: _Optional[str] = ...) -> None: ...

class DefaultUUID(_message.Message):
    __slots__ = ("value",)
    VALUE_FIELD_NUMBER: _ClassVar[int]
    value: str
    def __init__(self, value: _Optional[str] = ...) -> None: ...

class Media(_message.Message):
    __slots__ = ("id", "url", "title", "source", "description", "text", "content_type")
    ID_FIELD_NUMBER: _ClassVar[int]
    URL_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    CONTENT_TYPE_FIELD_NUMBER: _ClassVar[int]
    id: str
    url: str
    title: str
    source: str
    description: str
    text: str
    content_type: str
    def __init__(self, id: _Optional[str] = ..., url: _Optional[str] = ..., title: _Optional[str] = ..., source: _Optional[str] = ..., description: _Optional[str] = ..., text: _Optional[str] = ..., content_type: _Optional[str] = ...) -> None: ...

class MentionContext(_message.Message):
    __slots__ = ("is_mention", "is_reply", "is_thread", "mention_type")
    IS_MENTION_FIELD_NUMBER: _ClassVar[int]
    IS_REPLY_FIELD_NUMBER: _ClassVar[int]
    IS_THREAD_FIELD_NUMBER: _ClassVar[int]
    MENTION_TYPE_FIELD_NUMBER: _ClassVar[int]
    is_mention: bool
    is_reply: bool
    is_thread: bool
    mention_type: str
    def __init__(self, is_mention: bool = ..., is_reply: bool = ..., is_thread: bool = ..., mention_type: _Optional[str] = ...) -> None: ...

class Content(_message.Message):
    __slots__ = ("thought", "text", "actions", "providers", "source", "target", "url", "in_reply_to", "attachments", "channel_type", "mention_context", "response_message_id", "response_id", "simple", "type", "data")
    THOUGHT_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    ACTIONS_FIELD_NUMBER: _ClassVar[int]
    PROVIDERS_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    TARGET_FIELD_NUMBER: _ClassVar[int]
    URL_FIELD_NUMBER: _ClassVar[int]
    IN_REPLY_TO_FIELD_NUMBER: _ClassVar[int]
    ATTACHMENTS_FIELD_NUMBER: _ClassVar[int]
    CHANNEL_TYPE_FIELD_NUMBER: _ClassVar[int]
    MENTION_CONTEXT_FIELD_NUMBER: _ClassVar[int]
    RESPONSE_MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    RESPONSE_ID_FIELD_NUMBER: _ClassVar[int]
    SIMPLE_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    thought: str
    text: str
    actions: _containers.RepeatedScalarFieldContainer[str]
    providers: _containers.RepeatedScalarFieldContainer[str]
    source: str
    target: str
    url: str
    in_reply_to: str
    attachments: _containers.RepeatedCompositeFieldContainer[Media]
    channel_type: str
    mention_context: MentionContext
    response_message_id: str
    response_id: str
    simple: bool
    type: str
    data: _struct_pb2.Struct
    def __init__(self, thought: _Optional[str] = ..., text: _Optional[str] = ..., actions: _Optional[_Iterable[str]] = ..., providers: _Optional[_Iterable[str]] = ..., source: _Optional[str] = ..., target: _Optional[str] = ..., url: _Optional[str] = ..., in_reply_to: _Optional[str] = ..., attachments: _Optional[_Iterable[_Union[Media, _Mapping]]] = ..., channel_type: _Optional[str] = ..., mention_context: _Optional[_Union[MentionContext, _Mapping]] = ..., response_message_id: _Optional[str] = ..., response_id: _Optional[str] = ..., simple: bool = ..., type: _Optional[str] = ..., data: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class Metadata(_message.Message):
    __slots__ = ("values",)
    VALUES_FIELD_NUMBER: _ClassVar[int]
    values: _struct_pb2.Struct
    def __init__(self, values: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...
