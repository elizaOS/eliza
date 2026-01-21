//! Core types for elizaOS

// Proto-generated types (single source of truth)
pub mod generated;

// Type modules
pub mod agent;
pub mod components;
pub mod database;
pub mod environment;
pub mod events;
pub mod knowledge;
pub mod memory;
pub mod messaging;
pub mod model;
pub mod plugin;
pub mod primitives;
pub mod service;
pub mod service_interfaces;
pub mod settings;
pub mod state;
pub mod streaming;
pub mod task;
pub mod tee;
pub mod testing;

// Re-export commonly used types at the module level for convenience

// From primitives
pub use primitives::{
    as_uuid, string_to_uuid, ChannelType, Content, Media, MentionContext, Metadata, UUIDError,
    DEFAULT_UUID_STR, UUID,
};

// From agent
pub use agent::{
    Agent, AgentStatus, Bio, Character, CharacterSecrets, CharacterSettings, DirectoryItem,
    KnowledgeItem, MessageExample, StyleConfig, TemplateType,
};

// From components
pub use components::{
    ActionContext, ActionDefinition, ActionExample, ActionHandler, ActionParameter,
    ActionParameterSchema, ActionResult, EvaluationExample, EvaluatorDefinition, EvaluatorHandler,
    HandlerCallback, HandlerOptions, ProviderDefinition, ProviderHandler, ProviderResult,
};

// From memory
pub use memory::{Memory, MemoryMetadata, MemoryType, MessageMemory};

// From environment
pub use environment::{
    Component, Entity, Participant, Relationship, Room, RoomMetadata, World, WorldMetadata,
    WorldOwnership,
};

// From events
pub use events::{
    ActionEventPayload, ChannelClearedPayload, EmbeddingGenerationPayload, EmbeddingPriority,
    EntityEventMetadata, EntityPayload, EvaluatorEventPayload, EventPayload, EventType,
    InvokePayload, MessagePayload, ModelEventPayload, PlatformPrefix, RunEventPayload,
    RunStatus as EventRunStatus, TokenUsage, WorldPayload,
};

// From state
pub use state::{ActionPlan, ActionPlanStep, State, StateData, WorkingMemoryItem};

// From database
pub use database::{
    vector_dims, ActionLogBody, ActionLogContent, ActionLogResult, AgentRunCounts, AgentRunSummary,
    AgentRunSummaryResult, BaseLogBody, EmbeddingLogBody, EmbeddingSearchResult, EvaluatorLogBody,
    GetMemoriesParams, Log, LogBody, MemoryRetrievalOptions, MemorySearchOptions,
    ModelActionContext, ModelLogBody, PromptLogEntry, RunStatus, SearchMemoriesParams,
};

// From model
pub use model::{
    model_settings, model_type, DetokenizeTextParams, GenerateTextOptions, GenerateTextParams,
    GenerateTextResult, ImageDescriptionParams, ImageDescriptionResult, ImageGenerationParams,
    LLMMode, ModelHandlerInfo, ObjectGenerationParams, ObjectOutputType, ResearchAnnotation,
    ResearchParams, ResearchResult, ResearchTool, ResponseFormat, ResponseFormatType,
    TextEmbeddingParams, TextStreamChunk, TextToSpeechParams, TokenUsageInfo, TokenizeTextParams,
    TranscriptionParams,
};

// Bootstrap compatibility: some built-in bootstrap modules reference `crate::types::ModelType`.
// The core Rust runtime primarily uses string model type names (e.g. "TEXT_LARGE"), but the
// bootstrap plugin defines an enum wrapper used by its action APIs.
#[cfg(all(feature = "bootstrap-internal", not(feature = "wasm")))]
pub use crate::bootstrap::types::ModelType;

// Bootstrap compatibility: evaluators historically referenced this via `crate::types::*`.
#[cfg(all(feature = "bootstrap-internal", not(feature = "wasm")))]
pub use crate::bootstrap::types::EvaluatorResult;

// From plugin
pub use plugin::{
    ComponentTypeDefinition, HttpMethod, ModelHandlerFn, Plugin, PluginDefinition,
    ProjectAgentDefinition, ProjectDefinition, RouteDefinition,
};

// From task
pub use task::{GetTasksParams, Task, TaskStatus, TaskWorkerDefinition};

// From settings
pub use settings::{EnvironmentConfig, RuntimeSettings, SettingValue};

// From testing
pub use testing::{TestCase, TestSuite};
