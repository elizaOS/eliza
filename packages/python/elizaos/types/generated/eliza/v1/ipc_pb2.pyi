from eliza.v1 import components_pb2 as _components_pb2
from eliza.v1 import memory_pb2 as _memory_pb2
from eliza.v1 import plugin_pb2 as _plugin_pb2
from eliza.v1 import service_pb2 as _service_pb2
from eliza.v1 import state_pb2 as _state_pb2
from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class InteropProtocol(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    INTEROP_PROTOCOL_UNSPECIFIED: _ClassVar[InteropProtocol]
    INTEROP_PROTOCOL_WASM: _ClassVar[InteropProtocol]
    INTEROP_PROTOCOL_FFI: _ClassVar[InteropProtocol]
    INTEROP_PROTOCOL_IPC: _ClassVar[InteropProtocol]
    INTEROP_PROTOCOL_NATIVE: _ClassVar[InteropProtocol]

class PluginLanguage(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    PLUGIN_LANGUAGE_UNSPECIFIED: _ClassVar[PluginLanguage]
    PLUGIN_LANGUAGE_TYPESCRIPT: _ClassVar[PluginLanguage]
    PLUGIN_LANGUAGE_RUST: _ClassVar[PluginLanguage]
    PLUGIN_LANGUAGE_PYTHON: _ClassVar[PluginLanguage]
INTEROP_PROTOCOL_UNSPECIFIED: InteropProtocol
INTEROP_PROTOCOL_WASM: InteropProtocol
INTEROP_PROTOCOL_FFI: InteropProtocol
INTEROP_PROTOCOL_IPC: InteropProtocol
INTEROP_PROTOCOL_NATIVE: InteropProtocol
PLUGIN_LANGUAGE_UNSPECIFIED: PluginLanguage
PLUGIN_LANGUAGE_TYPESCRIPT: PluginLanguage
PLUGIN_LANGUAGE_RUST: PluginLanguage
PLUGIN_LANGUAGE_PYTHON: PluginLanguage

class PluginInteropConfig(_message.Message):
    __slots__ = ("protocol", "wasm_path", "shared_lib_path", "ipc_command", "ipc_port", "cwd")
    PROTOCOL_FIELD_NUMBER: _ClassVar[int]
    WASM_PATH_FIELD_NUMBER: _ClassVar[int]
    SHARED_LIB_PATH_FIELD_NUMBER: _ClassVar[int]
    IPC_COMMAND_FIELD_NUMBER: _ClassVar[int]
    IPC_PORT_FIELD_NUMBER: _ClassVar[int]
    CWD_FIELD_NUMBER: _ClassVar[int]
    protocol: InteropProtocol
    wasm_path: str
    shared_lib_path: str
    ipc_command: str
    ipc_port: int
    cwd: str
    def __init__(self, protocol: _Optional[_Union[InteropProtocol, str]] = ..., wasm_path: _Optional[str] = ..., shared_lib_path: _Optional[str] = ..., ipc_command: _Optional[str] = ..., ipc_port: _Optional[int] = ..., cwd: _Optional[str] = ...) -> None: ...

class CrossLanguagePluginManifest(_message.Message):
    __slots__ = ("name", "description", "version", "language", "interop", "config", "dependencies", "actions", "providers", "evaluators", "services", "routes", "events")
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
        value: _plugin_pb2.EventHandlerList
        def __init__(self, key: _Optional[str] = ..., value: _Optional[_Union[_plugin_pb2.EventHandlerList, _Mapping]] = ...) -> None: ...
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    INTEROP_FIELD_NUMBER: _ClassVar[int]
    CONFIG_FIELD_NUMBER: _ClassVar[int]
    DEPENDENCIES_FIELD_NUMBER: _ClassVar[int]
    ACTIONS_FIELD_NUMBER: _ClassVar[int]
    PROVIDERS_FIELD_NUMBER: _ClassVar[int]
    EVALUATORS_FIELD_NUMBER: _ClassVar[int]
    SERVICES_FIELD_NUMBER: _ClassVar[int]
    ROUTES_FIELD_NUMBER: _ClassVar[int]
    EVENTS_FIELD_NUMBER: _ClassVar[int]
    name: str
    description: str
    version: str
    language: PluginLanguage
    interop: PluginInteropConfig
    config: _containers.ScalarMap[str, str]
    dependencies: _containers.RepeatedScalarFieldContainer[str]
    actions: _containers.RepeatedCompositeFieldContainer[_components_pb2.ActionManifest]
    providers: _containers.RepeatedCompositeFieldContainer[_components_pb2.ProviderManifest]
    evaluators: _containers.RepeatedCompositeFieldContainer[_components_pb2.EvaluatorManifest]
    services: _containers.RepeatedCompositeFieldContainer[_service_pb2.ServiceManifest]
    routes: _containers.RepeatedCompositeFieldContainer[_plugin_pb2.RouteManifest]
    events: _containers.MessageMap[str, _plugin_pb2.EventHandlerList]
    def __init__(self, name: _Optional[str] = ..., description: _Optional[str] = ..., version: _Optional[str] = ..., language: _Optional[_Union[PluginLanguage, str]] = ..., interop: _Optional[_Union[PluginInteropConfig, _Mapping]] = ..., config: _Optional[_Mapping[str, str]] = ..., dependencies: _Optional[_Iterable[str]] = ..., actions: _Optional[_Iterable[_Union[_components_pb2.ActionManifest, _Mapping]]] = ..., providers: _Optional[_Iterable[_Union[_components_pb2.ProviderManifest, _Mapping]]] = ..., evaluators: _Optional[_Iterable[_Union[_components_pb2.EvaluatorManifest, _Mapping]]] = ..., services: _Optional[_Iterable[_Union[_service_pb2.ServiceManifest, _Mapping]]] = ..., routes: _Optional[_Iterable[_Union[_plugin_pb2.RouteManifest, _Mapping]]] = ..., events: _Optional[_Mapping[str, _plugin_pb2.EventHandlerList]] = ...) -> None: ...

class IPCMessage(_message.Message):
    __slots__ = ("type", "id")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    type: str
    id: str
    def __init__(self, type: _Optional[str] = ..., id: _Optional[str] = ...) -> None: ...

class ActionInvokeRequest(_message.Message):
    __slots__ = ("type", "id", "action", "memory", "state", "options")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    MEMORY_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    OPTIONS_FIELD_NUMBER: _ClassVar[int]
    type: str
    id: str
    action: str
    memory: _memory_pb2.Memory
    state: _state_pb2.State
    options: _struct_pb2.Struct
    def __init__(self, type: _Optional[str] = ..., id: _Optional[str] = ..., action: _Optional[str] = ..., memory: _Optional[_Union[_memory_pb2.Memory, _Mapping]] = ..., state: _Optional[_Union[_state_pb2.State, _Mapping]] = ..., options: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class ActionResultResponse(_message.Message):
    __slots__ = ("type", "id", "result")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    RESULT_FIELD_NUMBER: _ClassVar[int]
    type: str
    id: str
    result: _components_pb2.ActionResult
    def __init__(self, type: _Optional[str] = ..., id: _Optional[str] = ..., result: _Optional[_Union[_components_pb2.ActionResult, _Mapping]] = ...) -> None: ...

class ActionValidateRequest(_message.Message):
    __slots__ = ("type", "id", "action", "memory", "state")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    MEMORY_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    type: str
    id: str
    action: str
    memory: _memory_pb2.Memory
    state: _state_pb2.State
    def __init__(self, type: _Optional[str] = ..., id: _Optional[str] = ..., action: _Optional[str] = ..., memory: _Optional[_Union[_memory_pb2.Memory, _Mapping]] = ..., state: _Optional[_Union[_state_pb2.State, _Mapping]] = ...) -> None: ...

class ValidationResponse(_message.Message):
    __slots__ = ("type", "id", "valid")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    VALID_FIELD_NUMBER: _ClassVar[int]
    type: str
    id: str
    valid: bool
    def __init__(self, type: _Optional[str] = ..., id: _Optional[str] = ..., valid: bool = ...) -> None: ...

class ProviderGetRequest(_message.Message):
    __slots__ = ("type", "id", "provider", "memory", "state")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    MEMORY_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    type: str
    id: str
    provider: str
    memory: _memory_pb2.Memory
    state: _state_pb2.State
    def __init__(self, type: _Optional[str] = ..., id: _Optional[str] = ..., provider: _Optional[str] = ..., memory: _Optional[_Union[_memory_pb2.Memory, _Mapping]] = ..., state: _Optional[_Union[_state_pb2.State, _Mapping]] = ...) -> None: ...

class ProviderResultResponse(_message.Message):
    __slots__ = ("type", "id", "result")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    RESULT_FIELD_NUMBER: _ClassVar[int]
    type: str
    id: str
    result: _components_pb2.ProviderResult
    def __init__(self, type: _Optional[str] = ..., id: _Optional[str] = ..., result: _Optional[_Union[_components_pb2.ProviderResult, _Mapping]] = ...) -> None: ...

class EvaluatorInvokeRequest(_message.Message):
    __slots__ = ("type", "id", "evaluator", "memory", "state")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    EVALUATOR_FIELD_NUMBER: _ClassVar[int]
    MEMORY_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    type: str
    id: str
    evaluator: str
    memory: _memory_pb2.Memory
    state: _state_pb2.State
    def __init__(self, type: _Optional[str] = ..., id: _Optional[str] = ..., evaluator: _Optional[str] = ..., memory: _Optional[_Union[_memory_pb2.Memory, _Mapping]] = ..., state: _Optional[_Union[_state_pb2.State, _Mapping]] = ...) -> None: ...

class ServiceStartRequest(_message.Message):
    __slots__ = ("type", "id", "service")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    SERVICE_FIELD_NUMBER: _ClassVar[int]
    type: str
    id: str
    service: str
    def __init__(self, type: _Optional[str] = ..., id: _Optional[str] = ..., service: _Optional[str] = ...) -> None: ...

class ServiceStopRequest(_message.Message):
    __slots__ = ("type", "id", "service")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    SERVICE_FIELD_NUMBER: _ClassVar[int]
    type: str
    id: str
    service: str
    def __init__(self, type: _Optional[str] = ..., id: _Optional[str] = ..., service: _Optional[str] = ...) -> None: ...

class ServiceResponse(_message.Message):
    __slots__ = ("type", "id", "success", "error")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    type: str
    id: str
    success: bool
    error: str
    def __init__(self, type: _Optional[str] = ..., id: _Optional[str] = ..., success: bool = ..., error: _Optional[str] = ...) -> None: ...

class RouteHandlerRequest(_message.Message):
    __slots__ = ("type", "id", "path", "method", "body", "params", "query", "headers")
    class ParamsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    class QueryEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    class HeadersEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    TYPE_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    METHOD_FIELD_NUMBER: _ClassVar[int]
    BODY_FIELD_NUMBER: _ClassVar[int]
    PARAMS_FIELD_NUMBER: _ClassVar[int]
    QUERY_FIELD_NUMBER: _ClassVar[int]
    HEADERS_FIELD_NUMBER: _ClassVar[int]
    type: str
    id: str
    path: str
    method: str
    body: _struct_pb2.Struct
    params: _containers.ScalarMap[str, str]
    query: _containers.ScalarMap[str, str]
    headers: _containers.ScalarMap[str, str]
    def __init__(self, type: _Optional[str] = ..., id: _Optional[str] = ..., path: _Optional[str] = ..., method: _Optional[str] = ..., body: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., params: _Optional[_Mapping[str, str]] = ..., query: _Optional[_Mapping[str, str]] = ..., headers: _Optional[_Mapping[str, str]] = ...) -> None: ...

class RouteHandlerResponse(_message.Message):
    __slots__ = ("type", "id", "status", "headers", "body")
    class HeadersEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    TYPE_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    HEADERS_FIELD_NUMBER: _ClassVar[int]
    BODY_FIELD_NUMBER: _ClassVar[int]
    type: str
    id: str
    status: int
    headers: _containers.ScalarMap[str, str]
    body: _struct_pb2.Value
    def __init__(self, type: _Optional[str] = ..., id: _Optional[str] = ..., status: _Optional[int] = ..., headers: _Optional[_Mapping[str, str]] = ..., body: _Optional[_Union[_struct_pb2.Value, _Mapping]] = ...) -> None: ...

class PluginInitRequest(_message.Message):
    __slots__ = ("type", "id", "config")
    class ConfigEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    TYPE_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    CONFIG_FIELD_NUMBER: _ClassVar[int]
    type: str
    id: str
    config: _containers.ScalarMap[str, str]
    def __init__(self, type: _Optional[str] = ..., id: _Optional[str] = ..., config: _Optional[_Mapping[str, str]] = ...) -> None: ...

class PluginInitResponse(_message.Message):
    __slots__ = ("type", "id", "success", "error")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    type: str
    id: str
    success: bool
    error: str
    def __init__(self, type: _Optional[str] = ..., id: _Optional[str] = ..., success: bool = ..., error: _Optional[str] = ...) -> None: ...

class ErrorResponse(_message.Message):
    __slots__ = ("type", "id", "error", "details")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    DETAILS_FIELD_NUMBER: _ClassVar[int]
    type: str
    id: str
    error: str
    details: _struct_pb2.Struct
    def __init__(self, type: _Optional[str] = ..., id: _Optional[str] = ..., error: _Optional[str] = ..., details: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class IPCRequest(_message.Message):
    __slots__ = ("action_invoke", "action_validate", "provider_get", "evaluator_invoke", "service_start", "service_stop", "route_handle", "plugin_init")
    ACTION_INVOKE_FIELD_NUMBER: _ClassVar[int]
    ACTION_VALIDATE_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_GET_FIELD_NUMBER: _ClassVar[int]
    EVALUATOR_INVOKE_FIELD_NUMBER: _ClassVar[int]
    SERVICE_START_FIELD_NUMBER: _ClassVar[int]
    SERVICE_STOP_FIELD_NUMBER: _ClassVar[int]
    ROUTE_HANDLE_FIELD_NUMBER: _ClassVar[int]
    PLUGIN_INIT_FIELD_NUMBER: _ClassVar[int]
    action_invoke: ActionInvokeRequest
    action_validate: ActionValidateRequest
    provider_get: ProviderGetRequest
    evaluator_invoke: EvaluatorInvokeRequest
    service_start: ServiceStartRequest
    service_stop: ServiceStopRequest
    route_handle: RouteHandlerRequest
    plugin_init: PluginInitRequest
    def __init__(self, action_invoke: _Optional[_Union[ActionInvokeRequest, _Mapping]] = ..., action_validate: _Optional[_Union[ActionValidateRequest, _Mapping]] = ..., provider_get: _Optional[_Union[ProviderGetRequest, _Mapping]] = ..., evaluator_invoke: _Optional[_Union[EvaluatorInvokeRequest, _Mapping]] = ..., service_start: _Optional[_Union[ServiceStartRequest, _Mapping]] = ..., service_stop: _Optional[_Union[ServiceStopRequest, _Mapping]] = ..., route_handle: _Optional[_Union[RouteHandlerRequest, _Mapping]] = ..., plugin_init: _Optional[_Union[PluginInitRequest, _Mapping]] = ...) -> None: ...

class IPCResponse(_message.Message):
    __slots__ = ("action_result", "validation", "provider_result", "service", "route", "plugin_init", "error")
    ACTION_RESULT_FIELD_NUMBER: _ClassVar[int]
    VALIDATION_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_RESULT_FIELD_NUMBER: _ClassVar[int]
    SERVICE_FIELD_NUMBER: _ClassVar[int]
    ROUTE_FIELD_NUMBER: _ClassVar[int]
    PLUGIN_INIT_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    action_result: ActionResultResponse
    validation: ValidationResponse
    provider_result: ProviderResultResponse
    service: ServiceResponse
    route: RouteHandlerResponse
    plugin_init: PluginInitResponse
    error: ErrorResponse
    def __init__(self, action_result: _Optional[_Union[ActionResultResponse, _Mapping]] = ..., validation: _Optional[_Union[ValidationResponse, _Mapping]] = ..., provider_result: _Optional[_Union[ProviderResultResponse, _Mapping]] = ..., service: _Optional[_Union[ServiceResponse, _Mapping]] = ..., route: _Optional[_Union[RouteHandlerResponse, _Mapping]] = ..., plugin_init: _Optional[_Union[PluginInitResponse, _Mapping]] = ..., error: _Optional[_Union[ErrorResponse, _Mapping]] = ...) -> None: ...
