//! Runtime trait definitions for the elizaOS plugin system.
//!
//! This module defines the traits that the agent runtime must implement
//! for plugins to interact with the core system.

use async_trait::async_trait;
use std::collections::HashMap;
use uuid::Uuid;

use crate::error::PluginResult;
use crate::types::{Character, Content, Entity, Memory, MemoryType, ModelType, Room, State, World};

/// The agent runtime interface.
///
/// This trait defines the contract between plugins and the core runtime.
/// Plugins use this interface to access agent capabilities.
#[async_trait]
pub trait IAgentRuntime: Send + Sync {
    /// Get the agent's unique identifier.
    fn agent_id(&self) -> Uuid;

    /// Get the agent's character definition.
    fn character(&self) -> &Character;

    /// Get a setting value.
    fn get_setting(&self, key: &str) -> Option<String>;

    /// Get all settings.
    fn get_all_settings(&self) -> HashMap<String, String>;

    /// Set a setting value.
    async fn set_setting(&self, key: &str, value: &str) -> PluginResult<()>;

    /// Get an entity by ID.
    async fn get_entity(&self, entity_id: Uuid) -> PluginResult<Option<Entity>>;

    /// Update an entity.
    async fn update_entity(&self, entity: &Entity) -> PluginResult<()>;

    /// Get a room by ID.
    async fn get_room(&self, room_id: Uuid) -> PluginResult<Option<Room>>;

    /// Get a world by ID.
    async fn get_world(&self, world_id: Uuid) -> PluginResult<Option<World>>;

    /// Update a world.
    async fn update_world(&self, world: &World) -> PluginResult<()>;

    /// Create a memory entry.
    async fn create_memory(
        &self,
        content: Content,
        room_id: Option<Uuid>,
        entity_id: Option<Uuid>,
        memory_type: MemoryType,
        metadata: HashMap<String, serde_json::Value>,
    ) -> PluginResult<Memory>;

    /// Get memories with filters.
    async fn get_memories(
        &self,
        room_id: Option<Uuid>,
        entity_id: Option<Uuid>,
        memory_type: Option<MemoryType>,
        limit: usize,
    ) -> PluginResult<Vec<Memory>>;

    /// Search the knowledge base.
    async fn search_knowledge(&self, query: &str, limit: usize) -> PluginResult<Vec<Memory>>;

    /// Compose state for a message.
    async fn compose_state(&self, message: &Memory, providers: &[&str]) -> PluginResult<State>;

    /// Compose a prompt from state and template.
    fn compose_prompt(&self, state: &State, template: &str) -> String;

    /// Use a model for inference.
    async fn use_model(
        &self,
        model_type: ModelType,
        params: ModelParams,
    ) -> PluginResult<ModelOutput>;

    /// Check if a model type is available.
    fn has_model(&self, model_type: ModelType) -> bool;

    /// Get available actions.
    fn get_available_actions(&self) -> Vec<ActionInfo>;

    /// Get the current timestamp.
    fn get_current_timestamp(&self) -> i64;

    /// Log an info message.
    fn log_info(&self, source: &str, message: &str);

    /// Log a debug message.
    fn log_debug(&self, source: &str, message: &str);

    /// Log a warning message.
    fn log_warning(&self, source: &str, message: &str);

    /// Log an error message.
    fn log_error(&self, source: &str, message: &str);
}

/// Parameters for model calls.
#[derive(Debug, Clone)]
pub struct ModelParams {
    /// Text prompt for the model
    pub prompt: Option<String>,
    /// Text to embed (for embedding models)
    pub text: Option<String>,
    /// Additional parameters
    pub options: HashMap<String, serde_json::Value>,
}

impl ModelParams {
    /// Create params with just a prompt.
    pub fn with_prompt(prompt: impl Into<String>) -> Self {
        Self {
            prompt: Some(prompt.into()),
            text: None,
            options: HashMap::new(),
        }
    }

    /// Create params with just text (for embeddings).
    pub fn with_text(text: impl Into<String>) -> Self {
        Self {
            prompt: None,
            text: Some(text.into()),
            options: HashMap::new(),
        }
    }
}

/// Output from a model call.
#[derive(Debug, Clone)]
pub enum ModelOutput {
    /// Text output
    Text(String),
    /// Embedding vector
    Embedding(Vec<f32>),
    /// Image URL
    ImageUrl(String),
    /// Structured output
    Structured(serde_json::Value),
}

impl ModelOutput {
    /// Get as text, if this is a text output.
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(s) => Some(s),
            _ => None,
        }
    }

    /// Get as embedding, if this is an embedding output.
    pub fn as_embedding(&self) -> Option<&[f32]> {
        match self {
            Self::Embedding(v) => Some(v),
            _ => None,
        }
    }
}

/// Information about an available action.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ActionInfo {
    /// Action name
    pub name: String,
    /// Action description
    pub description: String,
}
