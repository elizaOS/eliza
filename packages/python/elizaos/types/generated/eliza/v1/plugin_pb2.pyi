from eliza.v1 import agent_pb2 as _agent_pb2
from eliza.v1 import components_pb2 as _components_pb2
from eliza.v1 import payment_pb2 as _payment_pb2
from eliza.v1 import service_pb2 as _service_pb2
from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class HttpMethod(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    HTTP_METHOD_UNSPECIFIED: _ClassVar[HttpMethod]
    HTTP_METHOD_GET: _ClassVar[HttpMethod]
    HTTP_METHOD_POST: _ClassVar[HttpMethod]
    HTTP_METHOD_PUT: _ClassVar[HttpMethod]
    HTTP_METHOD_PATCH: _ClassVar[HttpMethod]
    HTTP_METHOD_DELETE: _ClassVar[HttpMethod]
    HTTP_METHOD_STATIC: _ClassVar[HttpMethod]
HTTP_METHOD_UNSPECIFIED: HttpMethod
HTTP_METHOD_GET: HttpMethod
HTTP_METHOD_POST: HttpMethod
HTTP_METHOD_PUT: HttpMethod
HTTP_METHOD_PATCH: HttpMethod
HTTP_METHOD_DELETE: HttpMethod
HTTP_METHOD_STATIC: HttpMethod

class RouteManifest(_message.Message):
    __slots__ = ("method", "path", "name", "public", "is_multipart", "file_path", "x402")
    METHOD_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    PUBLIC_FIELD_NUMBER: _ClassVar[int]
    IS_MULTIPART_FIELD_NUMBER: _ClassVar[int]
    FILE_PATH_FIELD_NUMBER: _ClassVar[int]
    X402_FIELD_NUMBER: _ClassVar[int]
    method: HttpMethod
    path: str
    name: str
    public: bool
    is_multipart: bool
    file_path: str
    x402: _payment_pb2.X402Config
    def __init__(self, method: _Optional[_Union[HttpMethod, str]] = ..., path: _Optional[str] = ..., name: _Optional[str] = ..., public: bool = ..., is_multipart: bool = ..., file_path: _Optional[str] = ..., x402: _Optional[_Union[_payment_pb2.X402Config, _Mapping]] = ...) -> None: ...

class JSONSchemaDefinition(_message.Message):
    __slots__ = ("type", "properties", "items", "required", "enum_values", "description")
    class PropertiesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: JSONSchemaDefinition
        def __init__(self, key: _Optional[str] = ..., value: _Optional[_Union[JSONSchemaDefinition, _Mapping]] = ...) -> None: ...
    TYPE_FIELD_NUMBER: _ClassVar[int]
    PROPERTIES_FIELD_NUMBER: _ClassVar[int]
    ITEMS_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    ENUM_VALUES_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    type: str
    properties: _containers.MessageMap[str, JSONSchemaDefinition]
    items: JSONSchemaDefinition
    required: _containers.RepeatedScalarFieldContainer[str]
    enum_values: _containers.RepeatedScalarFieldContainer[str]
    description: str
    def __init__(self, type: _Optional[str] = ..., properties: _Optional[_Mapping[str, JSONSchemaDefinition]] = ..., items: _Optional[_Union[JSONSchemaDefinition, _Mapping]] = ..., required: _Optional[_Iterable[str]] = ..., enum_values: _Optional[_Iterable[str]] = ..., description: _Optional[str] = ...) -> None: ...

class ComponentTypeDefinition(_message.Message):
    __slots__ = ("name", "schema")
    NAME_FIELD_NUMBER: _ClassVar[int]
    SCHEMA_FIELD_NUMBER: _ClassVar[int]
    name: str
    schema: JSONSchemaDefinition
    def __init__(self, name: _Optional[str] = ..., schema: _Optional[_Union[JSONSchemaDefinition, _Mapping]] = ...) -> None: ...

class PluginManifest(_message.Message):
    __slots__ = ("name", "description", "config", "actions", "providers", "evaluators", "services", "routes", "component_types", "events", "dependencies", "test_dependencies", "priority", "schema")
    class ConfigEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    class EventsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: EventHandlerList
        def __init__(self, key: _Optional[str] = ..., value: _Optional[_Union[EventHandlerList, _Mapping]] = ...) -> None: ...
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    CONFIG_FIELD_NUMBER: _ClassVar[int]
    ACTIONS_FIELD_NUMBER: _ClassVar[int]
    PROVIDERS_FIELD_NUMBER: _ClassVar[int]
    EVALUATORS_FIELD_NUMBER: _ClassVar[int]
    SERVICES_FIELD_NUMBER: _ClassVar[int]
    ROUTES_FIELD_NUMBER: _ClassVar[int]
    COMPONENT_TYPES_FIELD_NUMBER: _ClassVar[int]
    EVENTS_FIELD_NUMBER: _ClassVar[int]
    DEPENDENCIES_FIELD_NUMBER: _ClassVar[int]
    TEST_DEPENDENCIES_FIELD_NUMBER: _ClassVar[int]
    PRIORITY_FIELD_NUMBER: _ClassVar[int]
    SCHEMA_FIELD_NUMBER: _ClassVar[int]
    name: str
    description: str
    config: _containers.ScalarMap[str, str]
    actions: _containers.RepeatedCompositeFieldContainer[_components_pb2.ActionManifest]
    providers: _containers.RepeatedCompositeFieldContainer[_components_pb2.ProviderManifest]
    evaluators: _containers.RepeatedCompositeFieldContainer[_components_pb2.EvaluatorManifest]
    services: _containers.RepeatedCompositeFieldContainer[_service_pb2.ServiceManifest]
    routes: _containers.RepeatedCompositeFieldContainer[RouteManifest]
    component_types: _containers.RepeatedCompositeFieldContainer[ComponentTypeDefinition]
    events: _containers.MessageMap[str, EventHandlerList]
    dependencies: _containers.RepeatedScalarFieldContainer[str]
    test_dependencies: _containers.RepeatedScalarFieldContainer[str]
    priority: int
    schema: _struct_pb2.Struct
    def __init__(self, name: _Optional[str] = ..., description: _Optional[str] = ..., config: _Optional[_Mapping[str, str]] = ..., actions: _Optional[_Iterable[_Union[_components_pb2.ActionManifest, _Mapping]]] = ..., providers: _Optional[_Iterable[_Union[_components_pb2.ProviderManifest, _Mapping]]] = ..., evaluators: _Optional[_Iterable[_Union[_components_pb2.EvaluatorManifest, _Mapping]]] = ..., services: _Optional[_Iterable[_Union[_service_pb2.ServiceManifest, _Mapping]]] = ..., routes: _Optional[_Iterable[_Union[RouteManifest, _Mapping]]] = ..., component_types: _Optional[_Iterable[_Union[ComponentTypeDefinition, _Mapping]]] = ..., events: _Optional[_Mapping[str, EventHandlerList]] = ..., dependencies: _Optional[_Iterable[str]] = ..., test_dependencies: _Optional[_Iterable[str]] = ..., priority: _Optional[int] = ..., schema: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class EventHandlerList(_message.Message):
    __slots__ = ("handlers",)
    HANDLERS_FIELD_NUMBER: _ClassVar[int]
    handlers: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, handlers: _Optional[_Iterable[str]] = ...) -> None: ...

class ProjectAgentManifest(_message.Message):
    __slots__ = ("character", "plugins")
    CHARACTER_FIELD_NUMBER: _ClassVar[int]
    PLUGINS_FIELD_NUMBER: _ClassVar[int]
    character: _agent_pb2.Character
    plugins: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, character: _Optional[_Union[_agent_pb2.Character, _Mapping]] = ..., plugins: _Optional[_Iterable[str]] = ...) -> None: ...

class ProjectManifest(_message.Message):
    __slots__ = ("agents",)
    AGENTS_FIELD_NUMBER: _ClassVar[int]
    agents: _containers.RepeatedCompositeFieldContainer[ProjectAgentManifest]
    def __init__(self, agents: _Optional[_Iterable[_Union[ProjectAgentManifest, _Mapping]]] = ...) -> None: ...
