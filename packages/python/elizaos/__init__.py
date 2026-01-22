from elizaos.character import parse_character, validate_character_config
from elizaos.generated.action_docs import (
    ActionDoc,
    ActionDocExampleCall,
    ActionDocParameter,
    ActionDocParameterExampleValue,
    ActionDocParameterSchema,
    EvaluatorDoc,
    EvaluatorDocExample,
    EvaluatorDocMessage,
    EvaluatorDocMessageContent,
    all_action_docs,
    all_actions_spec_version,
    all_evaluator_docs,
    all_evaluators_spec_version,
    core_action_docs,
    core_actions_spec_version,
    core_evaluator_docs,
    core_evaluators_spec_version,
)
from elizaos.generated.spec_helpers import (
    get_action_spec,
    get_evaluator_spec,
    get_provider_spec,
    require_action_spec,
    require_evaluator_spec,
    require_provider_spec,
)
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
from elizaos.services import DefaultMessageService, IMessageService, MessageProcessingResult
from elizaos.settings import (
    decrypt_object_values,
    decrypt_secret,
    decrypt_string_value,
    encrypt_object_values,
    encrypt_string_value,
    get_salt,
)
from elizaos.types import (
    UUID,
    Action,
    ActionContext,
    ActionExample,
    ActionResult,
    Agent,
    AgentStatus,
    BaseMetadata,
    Character,
    CharacterSettings,
    Component,
    Content,
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
    WorkingMemoryItem,
    World,
    WorldOwnership,
    as_uuid,
    string_to_uuid,
)
from elizaos.types.database import IDatabaseAdapter  # noqa: E402
from elizaos.types.runtime import IAgentRuntime  # noqa: E402
from elizaos.utils import compose_prompt, compose_prompt_from_state, get_current_time_ms

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
# Rebuild Pydantic models with forward references
# Only call model_rebuild on actual Pydantic BaseModel subclasses
for _type in [Plugin, Task, TaskWorker]:
    if hasattr(_type, "model_rebuild"):
        _type.model_rebuild(_types_namespace=_rebuild_ns)

__version__ = "1.0.0"

__all__ = [
    # Runtime
    "AgentRuntime",
    # Types - Primitives
    "UUID",
    "as_uuid",
    "string_to_uuid",
    "Content",
    "Media",
    "Metadata",
    "MentionContext",
    # Types - Memory
    "Memory",
    "MessageMemory",
    "MemoryMetadata",
    "BaseMetadata",
    "DocumentMetadata",
    "FragmentMetadata",
    "MessageMetadata",
    "DescriptionMetadata",
    "CustomMetadata",
    # Types - Agent
    "Character",
    "CharacterSettings",
    "Agent",
    "AgentStatus",
    "MessageExample",
    # Types - Environment
    "Entity",
    "Component",
    "World",
    "WorldOwnership",
    "Room",
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
    "WorkingMemoryItem",
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
    # Generated action/evaluator specs (centralized from packages/prompts)
    "ActionDoc",
    "ActionDocExampleCall",
    "ActionDocParameter",
    "ActionDocParameterSchema",
    "ActionDocParameterExampleValue",
    "EvaluatorDoc",
    "EvaluatorDocExample",
    "EvaluatorDocMessage",
    "EvaluatorDocMessageContent",
    "core_actions_spec_version",
    "all_actions_spec_version",
    "core_evaluators_spec_version",
    "all_evaluators_spec_version",
    "core_action_docs",
    "all_action_docs",
    "core_evaluator_docs",
    "all_evaluator_docs",
    # Spec helper functions
    "get_action_spec",
    "require_action_spec",
    "get_provider_spec",
    "require_provider_spec",
    "get_evaluator_spec",
    "require_evaluator_spec",
]
