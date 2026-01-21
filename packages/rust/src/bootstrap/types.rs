//! Core types for the elizaOS Bootstrap Plugin.
//!
//! This module defines the fundamental types used throughout the plugin,
//! including content, memory, actions, providers, and evaluators.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// Configuration for bootstrap capabilities.
///
/// - Basic: Core functionality (reply, ignore, none, choice actions; core providers; task/embedding services)
/// - Extended/Advanced: Additional features (contacts, room management, roles, settings, image generation)
/// - Autonomy: Autonomous operation (autonomy service, admin communication, status providers)
#[derive(Debug, Clone, Default)]
pub struct CapabilityConfig {
    /// Disable basic capabilities (default: false)
    pub disable_basic: bool,
    /// Enable extended capabilities (default: false)
    pub enable_extended: bool,
    /// Alias for enable_extended (for consistency with TypeScript)
    pub advanced_capabilities: bool,
    /// Skip the character provider (used for anonymous agents without a character file)
    pub skip_character_provider: bool,
    /// Enable autonomy capabilities (default: false)
    pub enable_autonomy: bool,
}

impl CapabilityConfig {
    /// Create a new capability config with defaults
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a config with basic capabilities only
    pub fn basic_only() -> Self {
        Self::default()
    }

    /// Create a config with extended capabilities enabled
    pub fn with_extended() -> Self {
        Self {
            disable_basic: false,
            enable_extended: true,
            advanced_capabilities: true,
            skip_character_provider: false,
            enable_autonomy: false,
        }
    }

    /// Create a config with advanced capabilities enabled (alias for with_extended)
    pub fn with_advanced() -> Self {
        Self::with_extended()
    }

    /// Create a config with only extended capabilities (no basic)
    pub fn extended_only() -> Self {
        Self {
            disable_basic: true,
            enable_extended: true,
            advanced_capabilities: true,
            skip_character_provider: false,
            enable_autonomy: false,
        }
    }

    /// Check if advanced/extended capabilities are enabled
    pub fn has_advanced(&self) -> bool {
        self.enable_extended || self.advanced_capabilities
    }

    /// Create a config for an anonymous agent (skips character provider)
    pub fn anonymous() -> Self {
        Self {
            disable_basic: false,
            enable_extended: false,
            advanced_capabilities: false,
            skip_character_provider: true,
            enable_autonomy: false,
        }
    }

    /// Create a config with autonomy enabled
    pub fn with_autonomy() -> Self {
        Self {
            disable_basic: false,
            enable_extended: false,
            advanced_capabilities: false,
            skip_character_provider: false,
            enable_autonomy: true,
        }
    }

    /// Create a config with extended and autonomy enabled
    pub fn with_extended_and_autonomy() -> Self {
        Self {
            disable_basic: false,
            enable_extended: true,
            advanced_capabilities: true,
            skip_character_provider: false,
            enable_autonomy: true,
        }
    }
}

/// Represents the content of a message or memory.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Content {
    /// The text content
    pub text: String,
    /// Optional thought/reasoning
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought: Option<String>,
    /// Actions associated with this content
    #[serde(default)]
    pub actions: Vec<String>,
    /// Providers that contributed to this content
    #[serde(default)]
    pub providers: Vec<String>,
    /// Target for the content (e.g., room or entity)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
    /// Attachments (images, files, etc.)
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

/// Target for a message or action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Target {
    /// Target room ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<Uuid>,
    /// Target entity ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<Uuid>,
}

/// An attachment (image, file, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    /// Attachment type
    #[serde(rename = "type")]
    pub attachment_type: String,
    /// URL to the attachment
    pub url: String,
}

/// Memory type enumeration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MemoryType {
    /// A message in a conversation
    Message,
    /// An action taken by the agent
    Action,
    /// A fact about an entity
    Fact,
    /// Knowledge from the knowledge base
    Knowledge,
}

/// Represents a memory entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memory {
    /// Unique identifier
    pub id: Uuid,
    /// Memory content
    pub content: Content,
    /// Room ID this memory belongs to
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<Uuid>,
    /// Entity ID that created this memory
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<Uuid>,
    /// Memory type
    pub memory_type: MemoryType,
    /// Creation timestamp
    pub created_at: DateTime<Utc>,
    /// Additional metadata
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

impl Default for Memory {
    fn default() -> Self {
        Self {
            id: Uuid::new_v4(),
            content: Content::default(),
            room_id: None,
            entity_id: None,
            memory_type: MemoryType::Message,
            created_at: Utc::now(),
            metadata: HashMap::new(),
        }
    }
}

/// Represents the state passed to handlers.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct State {
    /// Key-value pairs of state data
    #[serde(default)]
    pub values: HashMap<String, serde_json::Value>,
}

/// Result of an action execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    /// Human-readable result text
    pub text: String,
    /// Key-value pairs of result values
    #[serde(default)]
    pub values: HashMap<String, serde_json::Value>,
    /// Structured result data
    #[serde(default)]
    pub data: HashMap<String, serde_json::Value>,
    /// Whether the action succeeded
    pub success: bool,
    /// Error message if failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ActionResult {
    /// Create a successful action result.
    pub fn success(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            values: HashMap::new(),
            data: HashMap::new(),
            success: true,
            error: None,
        }
    }

    /// Create a failed action result.
    pub fn failure(text: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            values: HashMap::new(),
            data: HashMap::new(),
            success: false,
            error: Some(error.into()),
        }
    }

    /// Add a value to the result.
    pub fn with_value(
        mut self,
        key: impl Into<String>,
        value: impl Into<serde_json::Value>,
    ) -> Self {
        self.values.insert(key.into(), value.into());
        self
    }

    /// Add data to the result.
    pub fn with_data(
        mut self,
        key: impl Into<String>,
        value: impl Into<serde_json::Value>,
    ) -> Self {
        self.data.insert(key.into(), value.into());
        self
    }
}

/// Result from a provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderResult {
    /// Text context to include in prompts
    pub text: String,
    /// Key-value pairs of provider values
    #[serde(default)]
    pub values: HashMap<String, serde_json::Value>,
    /// Structured provider data
    #[serde(default)]
    pub data: HashMap<String, serde_json::Value>,
}

impl ProviderResult {
    /// Create a new provider result.
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            values: HashMap::new(),
            data: HashMap::new(),
        }
    }

    /// Add a value to the result.
    pub fn with_value(
        mut self,
        key: impl Into<String>,
        value: impl Into<serde_json::Value>,
    ) -> Self {
        self.values.insert(key.into(), value.into());
        self
    }

    /// Add data to the result.
    pub fn with_data(
        mut self,
        key: impl Into<String>,
        value: impl Into<serde_json::Value>,
    ) -> Self {
        self.data.insert(key.into(), value.into());
        self
    }
}

/// Result from an evaluator.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluatorResult {
    /// Numeric score (0-100)
    pub score: u8,
    /// Whether evaluation passed
    pub passed: bool,
    /// Reason for the result
    pub reason: String,
    /// Additional details
    #[serde(default)]
    pub details: HashMap<String, serde_json::Value>,
}

impl EvaluatorResult {
    /// Create a passing evaluation result.
    pub fn pass(score: u8, reason: impl Into<String>) -> Self {
        Self {
            score,
            passed: true,
            reason: reason.into(),
            details: HashMap::new(),
        }
    }

    /// Create a failing evaluation result.
    pub fn fail(score: u8, reason: impl Into<String>) -> Self {
        Self {
            score,
            passed: false,
            reason: reason.into(),
            details: HashMap::new(),
        }
    }

    /// Add details to the result.
    pub fn with_detail(
        mut self,
        key: impl Into<String>,
        value: impl Into<serde_json::Value>,
    ) -> Self {
        self.details.insert(key.into(), value.into());
        self
    }
}

/// Model types available in the runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ModelType {
    /// Large text generation model
    TextLarge,
    /// Small text generation model
    TextSmall,
    /// Text embedding model
    TextEmbedding,
    /// Image generation model
    Image,
    /// Audio transcription model
    AudioTranscription,
    /// Text to speech model
    TextToSpeech,
}

/// Represents an entity (user, agent, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entity {
    /// Unique identifier
    pub id: Uuid,
    /// Entity name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Entity type (user, agent, etc.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_type: Option<String>,
    /// Additional metadata
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

/// Represents a room/channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Room {
    /// Unique identifier
    pub id: Uuid,
    /// Room name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// World ID this room belongs to
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world_id: Option<Uuid>,
    /// Additional metadata
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

/// Represents a world/server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct World {
    /// Unique identifier
    pub id: Uuid,
    /// World name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Additional metadata
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

/// Character definition for an agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Character {
    /// Agent name
    pub name: String,
    /// Agent bio/description
    #[serde(default)]
    pub bio: String,
    /// Personality adjectives
    #[serde(default)]
    pub adjectives: Vec<String>,
    /// Background lore
    #[serde(default)]
    pub lore: String,
    /// Knowledge topics
    #[serde(default)]
    pub topics: Vec<String>,
    /// Style settings
    #[serde(default)]
    pub style: CharacterStyle,
    /// Prompt templates
    #[serde(default)]
    pub templates: HashMap<String, String>,
}

/// Style settings for a character.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CharacterStyle {
    /// General style guidelines
    #[serde(default)]
    pub all: Vec<String>,
    /// Chat-specific style
    #[serde(default)]
    pub chat: Vec<String>,
    /// Post-specific style
    #[serde(default)]
    pub post: Vec<String>,
}

/// Role enumeration for entities in a world.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Role {
    Owner,
    Admin,
    Member,
    Guest,
    None,
}

impl Default for Role {
    fn default() -> Self {
        Self::None
    }
}
