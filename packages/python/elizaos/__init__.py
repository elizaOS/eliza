"""
elizaOS Core - The Python runtime and types for elizaOS AI agents.

This package provides the core functionality for building AI agents with elizaOS,
including the AgentRuntime, plugin system, and all core types.
"""

from elizaos.character import parse_character, validate_character_config
from elizaos.logger import Logger, create_logger
from elizaos.plugin import load_plugin, register_plugin
from elizaos.prompts import (
    BOOLEAN_FOOTER,
    CHOOSE_OPTION_TEMPLATE,
    IMAGE_GENERATION_TEMPLATE,
    MESSAGE_HANDLER_TEMPLATE,
    REFLECTION_TEMPLATE,
    REPLY_TEMPLATE,
    SHOULD_RESPOND_TEMPLATE,
    UPDATE_ENTITY_TEMPLATE,
    UPDATE_SETTINGS_TEMPLATE,
)
from elizaos.runtime import AgentRuntime
from elizaos.settings import (
    decrypt_object_values,
    decrypt_secret,
    decrypt_string_value,
    encrypt_object_values,
    encrypt_string_value,
    get_salt,
)
from elizaos.services import DefaultMessageService, IMessageService, MessageProcessingResult
from elizaos.utils import compose_prompt, compose_prompt_from_state, get_current_time_ms
from elizaos.types import (
    UUID,
    Action,
    ActionContext,
    ActionExample,
    ActionResult,
    Agent,
    AgentStatus,
    BaseMetadata,
    ChannelType,
    Character,
    Component,
    Content,
    ContentType,
    CustomMetadata,
    DescriptionMetadata,
    DocumentMetadata,
    Entity,
    EvaluationExample,
    Evaluator,
    EventPayload,
    EventType,
    FragmentMetadata,
    HandlerCallback,
    HandlerOptions,
    LLMMode,
    Log,
    Media,
    Memory,
    MemoryMetadata,
    MemoryScope,
    MemoryType,
    MentionContext,
    MessageExample,
    MessageMemory,
    MessageMetadata,
    Metadata,
    ModelType,
    Participant,
    Plugin,
    Provider,
    ProviderResult,
    Relationship,
    Role,
    Room,
    Route,
    RouteRequest,
    RouteResponse,
    Service,
    ServiceType,
    ServiceTypeName,
    State,
    StateData,
    Task,
    TaskWorker,
    World,
    as_uuid,
    string_to_uuid,
)
from elizaos.types.database import IDatabaseAdapter  # noqa: E402

# Rebuild models with forward references
from elizaos.types.runtime import IAgentRuntime  # noqa: E402

_rebuild_ns = {
    "IAgentRuntime": IAgentRuntime,
    "IDatabaseAdapter": IDatabaseAdapter,
    "Service": Service,
    "Action": Action,
    "Evaluator": Evaluator,
    "Provider": Provider,
    "Task": Task,
    "Memory": Memory,
    "State": State,
    "Character": Character,
    "Plugin": Plugin,
    "Route": Route,
    "HandlerOptions": HandlerOptions,
    "ActionResult": ActionResult,
}
Plugin.model_rebuild(_types_namespace=_rebuild_ns)
Action.model_rebuild(_types_namespace=_rebuild_ns)
Evaluator.model_rebuild(_types_namespace=_rebuild_ns)
Provider.model_rebuild(_types_namespace=_rebuild_ns)
TaskWorker.model_rebuild(_types_namespace=_rebuild_ns)

__version__ = "1.0.0"

__all__ = [
    # Runtime
    "AgentRuntime",
    # Types - Primitives
    "UUID",
    "as_uuid",
    "string_to_uuid",
    "Content",
    "ContentType",
    "Media",
    "Metadata",
    "MentionContext",
    # Types - Memory
    "Memory",
    "MessageMemory",
    "MemoryType",
    "MemoryScope",
    "MemoryMetadata",
    "BaseMetadata",
    "DocumentMetadata",
    "FragmentMetadata",
    "MessageMetadata",
    "DescriptionMetadata",
    "CustomMetadata",
    # Types - Agent
    "Character",
    "Agent",
    "AgentStatus",
    "MessageExample",
    # Types - Environment
    "Entity",
    "Component",
    "World",
    "Room",
    "ChannelType",
    "Role",
    "Participant",
    "Relationship",
    # Types - Components
    "Action",
    "ActionExample",
    "ActionResult",
    "ActionContext",
    "Evaluator",
    "EvaluationExample",
    "Provider",
    "ProviderResult",
    "HandlerCallback",
    "HandlerOptions",
    # Types - Plugin
    "Plugin",
    "Route",
    "RouteRequest",
    "RouteResponse",
    # Types - Service
    "Service",
    "ServiceType",
    "ServiceTypeName",
    # Types - State
    "State",
    "StateData",
    # Types - Events
    "EventType",
    "EventPayload",
    # Types - Task
    "Task",
    "TaskWorker",
    # Types - Logging
    "Log",
    # Types - Model
    "LLMMode",
    "ModelType",
    # Logger
    "create_logger",
    "Logger",
    # Plugin utilities
    "load_plugin",
    "register_plugin",
    # Character utilities
    "parse_character",
    "validate_character_config",
    # Message service
    "DefaultMessageService",
    "IMessageService",
    "MessageProcessingResult",
    # Prompts
    "BOOLEAN_FOOTER",
    "CHOOSE_OPTION_TEMPLATE",
    "IMAGE_GENERATION_TEMPLATE",
    "MESSAGE_HANDLER_TEMPLATE",
    "REFLECTION_TEMPLATE",
    "REPLY_TEMPLATE",
    "SHOULD_RESPOND_TEMPLATE",
    "UPDATE_ENTITY_TEMPLATE",
    "UPDATE_SETTINGS_TEMPLATE",
    # Settings / secrets helpers
    "get_salt",
    "encrypt_string_value",
    "decrypt_string_value",
    "encrypt_object_values",
    "decrypt_object_values",
    "decrypt_secret",
    # Prompt composition helpers
    "compose_prompt",
    "compose_prompt_from_state",
    "get_current_time_ms",
]
