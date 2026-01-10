//! Core types for elizaOS
//!
//! This module contains all the fundamental types used throughout the elizaOS system.
//! All types are designed to serialize/deserialize to JSON in a format identical to
//! the TypeScript implementation.

mod agent;
mod components;
mod database;
mod environment;
mod events;
mod knowledge;
mod memory;
mod messaging;
mod model;
mod plugin;
mod primitives;
mod service;
mod service_interfaces;
mod settings;
mod state;
mod streaming;
mod task;
mod tee;
mod testing;

// Re-export main types explicitly to avoid ambiguity
pub use agent::{
    Agent, AgentStatus, Bio, Character, CharacterSecrets, CharacterSettings, KnowledgeItem,
    MessageExample, StyleConfig, TemplateType,
};
pub use components::{
    ActionContext, ActionDefinition, ActionExample, ActionHandler, ActionParameter,
    ActionParameterSchema, ActionPlan, ActionPlanStep, ActionResult, ActionStepStatus,
    EvaluationExample, EvaluatorDefinition, EvaluatorHandler, HandlerCallback, HandlerOptions,
    ProviderDefinition, ProviderHandler, ProviderResult,
};
pub use database::{
    vector_dims, ActionLogBody, ActionLogContent, ActionLogResult, AgentRunCounts, AgentRunSummary,
    AgentRunSummaryResult, BaseLogBody, EmbeddingLogBody, EmbeddingSearchResult, EvaluatorLogBody,
    GetMemoriesParams, Log, LogBody, MemoryRetrievalOptions, MemorySearchOptions,
    ModelActionContext, ModelLogBody, PromptLogEntry, RunStatus as DbRunStatus,
    SearchMemoriesParams,
};
pub use environment::{
    ChannelType, Component, Entity, Participant, Relationship, Role, Room, World, WorldMetadata,
    WorldOwnership,
};
pub use events::{
    ActionEventPayload, ChannelClearedPayload, EmbeddingGenerationPayload, EmbeddingPriority,
    EntityEventMetadata, EntityPayload, EvaluatorEventPayload, EventPayload, EventType,
    InvokePayload, MessagePayload, ModelEventPayload, PlatformPrefix, RunEventPayload,
    RunStatus as EventRunStatus, TokenUsage, WorldPayload,
};
pub use knowledge::{DirectoryItem, KnowledgeChunk, KnowledgeDocument, KnowledgeSource};
pub use memory::{
    BaseMetadata, DescriptionMetadata, DocumentMetadata, FragmentMetadata, Memory, MemoryMetadata,
    MemoryScope, MemoryType, MessageMemory, MessageMetadata,
};
pub use messaging::{
    ControlMessage, ControlMessageType, MessageQueueItem, MessageQueueStatus, SendHandlerInfo,
    TargetInfo, TargetType,
};
pub use model::{
    model_settings, model_type, DetokenizeTextParams, GenerateTextOptions, GenerateTextParams,
    GenerateTextResult, ImageDescriptionParams, ImageDescriptionResult, ImageGenerationParams,
    ModelHandlerInfo, ObjectGenerationParams, ObjectOutputType, ResponseFormat, ResponseFormatType,
    TextEmbeddingParams, TextStreamChunk, TextToSpeechParams, TokenUsageInfo, TokenizeTextParams,
    TranscriptionParams,
};
pub use plugin::{
    ComponentTypeDefinition, HttpMethod, ModelHandlerFn, Plugin, PluginDefinition,
    ProjectAgentDefinition, ProjectDefinition, RouteDefinition,
};
pub use primitives::{
    as_uuid, string_to_uuid, Content, ContentType, Media, MentionContext, MentionType, Metadata,
    UUIDError, DEFAULT_UUID_STR, UUID,
};
pub use service::{service_type, Service, ServiceDefinition, ServiceError, TypedService};
pub use service_interfaces::*;
pub use settings::{EnvironmentConfig, RuntimeSettings, SettingValue};
pub use state::{State, StateData};
pub use streaming::IStreamExtractor;
pub use task::{GetTasksParams, Task, TaskStatus, TaskWorkerDefinition};
pub use tee::{
    DeriveKeyAttestationData, RemoteAttestationMessage, RemoteAttestationMessageContent,
    RemoteAttestationQuote, TeeAgent, TeePluginConfig, TeeType, TEEMode,
};
pub use testing::{
    TestCase, TestCaseDefinition, TestError, TestResults, TestSuite, TestSuiteDefinition,
};
