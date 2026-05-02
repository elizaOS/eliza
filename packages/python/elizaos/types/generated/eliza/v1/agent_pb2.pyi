from eliza.v1 import primitives_pb2 as _primitives_pb2
from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Iterable as _Iterable, Mapping as _Mapping, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class AgentStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    AGENT_STATUS_UNSPECIFIED: _ClassVar[AgentStatus]
    AGENT_STATUS_ACTIVE: _ClassVar[AgentStatus]
    AGENT_STATUS_INACTIVE: _ClassVar[AgentStatus]
AGENT_STATUS_UNSPECIFIED: AgentStatus
AGENT_STATUS_ACTIVE: AgentStatus
AGENT_STATUS_INACTIVE: AgentStatus

class MessageExample(_message.Message):
    __slots__ = ("name", "content")
    NAME_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    name: str
    content: _primitives_pb2.Content
    def __init__(self, name: _Optional[str] = ..., content: _Optional[_Union[_primitives_pb2.Content, _Mapping]] = ...) -> None: ...

class KnowledgeItem(_message.Message):
    __slots__ = ("path", "directory")
    PATH_FIELD_NUMBER: _ClassVar[int]
    DIRECTORY_FIELD_NUMBER: _ClassVar[int]
    path: str
    directory: KnowledgeDirectory
    def __init__(self, path: _Optional[str] = ..., directory: _Optional[_Union[KnowledgeDirectory, _Mapping]] = ...) -> None: ...

class KnowledgeDirectory(_message.Message):
    __slots__ = ("path", "shared")
    PATH_FIELD_NUMBER: _ClassVar[int]
    SHARED_FIELD_NUMBER: _ClassVar[int]
    path: str
    shared: bool
    def __init__(self, path: _Optional[str] = ..., shared: bool = ...) -> None: ...

class CharacterSettings(_message.Message):
    __slots__ = ("should_respond_model", "use_multi_step", "max_multistep_iterations", "basic_capabilities_defllmoff", "basic_capabilities_keep_resp", "providers_total_timeout_ms", "max_working_memory_entries", "always_respond_channels", "always_respond_sources", "default_temperature", "default_max_tokens", "default_frequency_penalty", "default_presence_penalty", "disable_basic_capabilities", "enable_extended_capabilities", "extra", "enable_knowledge", "enable_relationships", "enable_trajectories")
    SHOULD_RESPOND_MODEL_FIELD_NUMBER: _ClassVar[int]
    USE_MULTI_STEP_FIELD_NUMBER: _ClassVar[int]
    MAX_MULTISTEP_ITERATIONS_FIELD_NUMBER: _ClassVar[int]
    BASIC_CAPABILITIES_DEFLLMOFF_FIELD_NUMBER: _ClassVar[int]
    BASIC_CAPABILITIES_KEEP_RESP_FIELD_NUMBER: _ClassVar[int]
    PROVIDERS_TOTAL_TIMEOUT_MS_FIELD_NUMBER: _ClassVar[int]
    MAX_WORKING_MEMORY_ENTRIES_FIELD_NUMBER: _ClassVar[int]
    ALWAYS_RESPOND_CHANNELS_FIELD_NUMBER: _ClassVar[int]
    ALWAYS_RESPOND_SOURCES_FIELD_NUMBER: _ClassVar[int]
    DEFAULT_TEMPERATURE_FIELD_NUMBER: _ClassVar[int]
    DEFAULT_MAX_TOKENS_FIELD_NUMBER: _ClassVar[int]
    DEFAULT_FREQUENCY_PENALTY_FIELD_NUMBER: _ClassVar[int]
    DEFAULT_PRESENCE_PENALTY_FIELD_NUMBER: _ClassVar[int]
    DISABLE_BASIC_CAPABILITIES_FIELD_NUMBER: _ClassVar[int]
    ENABLE_EXTENDED_CAPABILITIES_FIELD_NUMBER: _ClassVar[int]
    EXTRA_FIELD_NUMBER: _ClassVar[int]
    ENABLE_KNOWLEDGE_FIELD_NUMBER: _ClassVar[int]
    ENABLE_RELATIONSHIPS_FIELD_NUMBER: _ClassVar[int]
    ENABLE_TRAJECTORIES_FIELD_NUMBER: _ClassVar[int]
    should_respond_model: str
    use_multi_step: bool
    max_multistep_iterations: int
    basic_capabilities_defllmoff: bool
    basic_capabilities_keep_resp: bool
    providers_total_timeout_ms: int
    max_working_memory_entries: int
    always_respond_channels: str
    always_respond_sources: str
    default_temperature: float
    default_max_tokens: int
    default_frequency_penalty: float
    default_presence_penalty: float
    disable_basic_capabilities: bool
    enable_extended_capabilities: bool
    extra: _struct_pb2.Struct
    enable_knowledge: bool
    enable_relationships: bool
    enable_trajectories: bool
    def __init__(self, should_respond_model: _Optional[str] = ..., use_multi_step: bool = ..., max_multistep_iterations: _Optional[int] = ..., basic_capabilities_defllmoff: bool = ..., basic_capabilities_keep_resp: bool = ..., providers_total_timeout_ms: _Optional[int] = ..., max_working_memory_entries: _Optional[int] = ..., always_respond_channels: _Optional[str] = ..., always_respond_sources: _Optional[str] = ..., default_temperature: _Optional[float] = ..., default_max_tokens: _Optional[int] = ..., default_frequency_penalty: _Optional[float] = ..., default_presence_penalty: _Optional[float] = ..., disable_basic_capabilities: bool = ..., enable_extended_capabilities: bool = ..., extra: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., enable_knowledge: bool = ..., enable_relationships: bool = ..., enable_trajectories: bool = ...) -> None: ...

class StyleGuides(_message.Message):
    __slots__ = ("all", "chat", "post")
    ALL_FIELD_NUMBER: _ClassVar[int]
    CHAT_FIELD_NUMBER: _ClassVar[int]
    POST_FIELD_NUMBER: _ClassVar[int]
    all: _containers.RepeatedScalarFieldContainer[str]
    chat: _containers.RepeatedScalarFieldContainer[str]
    post: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, all: _Optional[_Iterable[str]] = ..., chat: _Optional[_Iterable[str]] = ..., post: _Optional[_Iterable[str]] = ...) -> None: ...

class Character(_message.Message):
    __slots__ = ("id", "name", "username", "system", "templates", "bio", "message_examples", "post_examples", "topics", "adjectives", "knowledge", "plugins", "settings", "secrets", "style", "advanced_planning", "advanced_memory")
    class TemplatesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    class SecretsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    USERNAME_FIELD_NUMBER: _ClassVar[int]
    SYSTEM_FIELD_NUMBER: _ClassVar[int]
    TEMPLATES_FIELD_NUMBER: _ClassVar[int]
    BIO_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_EXAMPLES_FIELD_NUMBER: _ClassVar[int]
    POST_EXAMPLES_FIELD_NUMBER: _ClassVar[int]
    TOPICS_FIELD_NUMBER: _ClassVar[int]
    ADJECTIVES_FIELD_NUMBER: _ClassVar[int]
    KNOWLEDGE_FIELD_NUMBER: _ClassVar[int]
    PLUGINS_FIELD_NUMBER: _ClassVar[int]
    SETTINGS_FIELD_NUMBER: _ClassVar[int]
    SECRETS_FIELD_NUMBER: _ClassVar[int]
    STYLE_FIELD_NUMBER: _ClassVar[int]
    ADVANCED_PLANNING_FIELD_NUMBER: _ClassVar[int]
    ADVANCED_MEMORY_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    username: str
    system: str
    templates: _containers.ScalarMap[str, str]
    bio: _containers.RepeatedScalarFieldContainer[str]
    message_examples: _containers.RepeatedCompositeFieldContainer[MessageExampleGroup]
    post_examples: _containers.RepeatedScalarFieldContainer[str]
    topics: _containers.RepeatedScalarFieldContainer[str]
    adjectives: _containers.RepeatedScalarFieldContainer[str]
    knowledge: _containers.RepeatedCompositeFieldContainer[KnowledgeItem]
    plugins: _containers.RepeatedScalarFieldContainer[str]
    settings: CharacterSettings
    secrets: _containers.ScalarMap[str, str]
    style: StyleGuides
    advanced_planning: bool
    advanced_memory: bool
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ..., username: _Optional[str] = ..., system: _Optional[str] = ..., templates: _Optional[_Mapping[str, str]] = ..., bio: _Optional[_Iterable[str]] = ..., message_examples: _Optional[_Iterable[_Union[MessageExampleGroup, _Mapping]]] = ..., post_examples: _Optional[_Iterable[str]] = ..., topics: _Optional[_Iterable[str]] = ..., adjectives: _Optional[_Iterable[str]] = ..., knowledge: _Optional[_Iterable[_Union[KnowledgeItem, _Mapping]]] = ..., plugins: _Optional[_Iterable[str]] = ..., settings: _Optional[_Union[CharacterSettings, _Mapping]] = ..., secrets: _Optional[_Mapping[str, str]] = ..., style: _Optional[_Union[StyleGuides, _Mapping]] = ..., advanced_planning: bool = ..., advanced_memory: bool = ...) -> None: ...

class MessageExampleGroup(_message.Message):
    __slots__ = ("examples",)
    EXAMPLES_FIELD_NUMBER: _ClassVar[int]
    examples: _containers.RepeatedCompositeFieldContainer[MessageExample]
    def __init__(self, examples: _Optional[_Iterable[_Union[MessageExample, _Mapping]]] = ...) -> None: ...

class Agent(_message.Message):
    __slots__ = ("character", "enabled", "status", "created_at", "updated_at")
    CHARACTER_FIELD_NUMBER: _ClassVar[int]
    ENABLED_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    character: Character
    enabled: bool
    status: AgentStatus
    created_at: int
    updated_at: int
    def __init__(self, character: _Optional[_Union[Character, _Mapping]] = ..., enabled: bool = ..., status: _Optional[_Union[AgentStatus, str]] = ..., created_at: _Optional[int] = ..., updated_at: _Optional[int] = ...) -> None: ...
