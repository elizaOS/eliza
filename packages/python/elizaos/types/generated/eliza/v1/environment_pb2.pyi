from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class Component(_message.Message):
    __slots__ = ("id", "entity_id", "agent_id", "room_id", "world_id", "source_entity_id", "type", "created_at", "data")
    ID_FIELD_NUMBER: _ClassVar[int]
    ENTITY_ID_FIELD_NUMBER: _ClassVar[int]
    AGENT_ID_FIELD_NUMBER: _ClassVar[int]
    ROOM_ID_FIELD_NUMBER: _ClassVar[int]
    WORLD_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_ENTITY_ID_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    id: str
    entity_id: str
    agent_id: str
    room_id: str
    world_id: str
    source_entity_id: str
    type: str
    created_at: int
    data: _struct_pb2.Struct
    def __init__(self, id: _Optional[str] = ..., entity_id: _Optional[str] = ..., agent_id: _Optional[str] = ..., room_id: _Optional[str] = ..., world_id: _Optional[str] = ..., source_entity_id: _Optional[str] = ..., type: _Optional[str] = ..., created_at: _Optional[int] = ..., data: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class Entity(_message.Message):
    __slots__ = ("id", "names", "metadata", "agent_id", "components")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAMES_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    AGENT_ID_FIELD_NUMBER: _ClassVar[int]
    COMPONENTS_FIELD_NUMBER: _ClassVar[int]
    id: str
    names: _containers.RepeatedScalarFieldContainer[str]
    metadata: _struct_pb2.Struct
    agent_id: str
    components: _containers.RepeatedCompositeFieldContainer[Component]
    def __init__(self, id: _Optional[str] = ..., names: _Optional[_Iterable[str]] = ..., metadata: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., agent_id: _Optional[str] = ..., components: _Optional[_Iterable[_Union[Component, _Mapping]]] = ...) -> None: ...

class WorldOwnership(_message.Message):
    __slots__ = ("owner_id",)
    OWNER_ID_FIELD_NUMBER: _ClassVar[int]
    owner_id: str
    def __init__(self, owner_id: _Optional[str] = ...) -> None: ...

class WorldMetadata(_message.Message):
    __slots__ = ("ownership", "roles", "extra")
    class RolesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    OWNERSHIP_FIELD_NUMBER: _ClassVar[int]
    ROLES_FIELD_NUMBER: _ClassVar[int]
    EXTRA_FIELD_NUMBER: _ClassVar[int]
    ownership: WorldOwnership
    roles: _containers.ScalarMap[str, str]
    extra: _struct_pb2.Struct
    def __init__(self, ownership: _Optional[_Union[WorldOwnership, _Mapping]] = ..., roles: _Optional[_Mapping[str, str]] = ..., extra: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class World(_message.Message):
    __slots__ = ("id", "name", "agent_id", "message_server_id", "metadata")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    AGENT_ID_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_SERVER_ID_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    agent_id: str
    message_server_id: str
    metadata: WorldMetadata
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ..., agent_id: _Optional[str] = ..., message_server_id: _Optional[str] = ..., metadata: _Optional[_Union[WorldMetadata, _Mapping]] = ...) -> None: ...

class RoomMetadata(_message.Message):
    __slots__ = ("values",)
    VALUES_FIELD_NUMBER: _ClassVar[int]
    values: _struct_pb2.Struct
    def __init__(self, values: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class Room(_message.Message):
    __slots__ = ("id", "name", "agent_id", "source", "type", "channel_id", "message_server_id", "world_id", "metadata")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    AGENT_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    CHANNEL_ID_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_SERVER_ID_FIELD_NUMBER: _ClassVar[int]
    WORLD_ID_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    agent_id: str
    source: str
    type: str
    channel_id: str
    message_server_id: str
    world_id: str
    metadata: RoomMetadata
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ..., agent_id: _Optional[str] = ..., source: _Optional[str] = ..., type: _Optional[str] = ..., channel_id: _Optional[str] = ..., message_server_id: _Optional[str] = ..., world_id: _Optional[str] = ..., metadata: _Optional[_Union[RoomMetadata, _Mapping]] = ...) -> None: ...

class Participant(_message.Message):
    __slots__ = ("id", "entity")
    ID_FIELD_NUMBER: _ClassVar[int]
    ENTITY_FIELD_NUMBER: _ClassVar[int]
    id: str
    entity: Entity
    def __init__(self, id: _Optional[str] = ..., entity: _Optional[_Union[Entity, _Mapping]] = ...) -> None: ...

class Relationship(_message.Message):
    __slots__ = ("id", "source_entity_id", "target_entity_id", "agent_id", "tags", "metadata", "created_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_ENTITY_ID_FIELD_NUMBER: _ClassVar[int]
    TARGET_ENTITY_ID_FIELD_NUMBER: _ClassVar[int]
    AGENT_ID_FIELD_NUMBER: _ClassVar[int]
    TAGS_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    source_entity_id: str
    target_entity_id: str
    agent_id: str
    tags: _containers.RepeatedScalarFieldContainer[str]
    metadata: _struct_pb2.Struct
    created_at: str
    def __init__(self, id: _Optional[str] = ..., source_entity_id: _Optional[str] = ..., target_entity_id: _Optional[str] = ..., agent_id: _Optional[str] = ..., tags: _Optional[_Iterable[str]] = ..., metadata: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., created_at: _Optional[str] = ...) -> None: ...
