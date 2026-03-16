//! Event types for elizaOS
//!
//! Contains event types, payloads, and handlers for the event system.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::environment::{Entity, Room, World};
use super::memory::Memory;
use super::primitives::{Content, UUID};

/// Standard event types across all platforms
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EventType {
    // World events
    /// Agent joined a world
    WorldJoined,
    /// Agent connected to a world
    WorldConnected,
    /// Agent left a world
    WorldLeft,

    // Entity events
    /// Entity joined
    EntityJoined,
    /// Entity left
    EntityLeft,
    /// Entity updated
    EntityUpdated,

    // Room events
    /// Joined a room
    RoomJoined,
    /// Left a room
    RoomLeft,

    // Message events
    /// Message received
    MessageReceived,
    /// Message sent
    MessageSent,
    /// Message deleted
    MessageDeleted,

    // Channel events
    /// Channel cleared
    ChannelCleared,

    // Voice events
    /// Voice message received
    VoiceMessageReceived,
    /// Voice message sent
    VoiceMessageSent,

    // Interaction events
    /// Reaction received
    ReactionReceived,
    /// Post generated
    PostGenerated,
    /// Interaction received
    InteractionReceived,

    // Run events
    /// Run started
    RunStarted,
    /// Run ended
    RunEnded,
    /// Run timed out
    RunTimeout,

    // Action events
    /// Action started
    ActionStarted,
    /// Action completed
    ActionCompleted,

    // Evaluator events
    /// Evaluator started
    EvaluatorStarted,
    /// Evaluator completed
    EvaluatorCompleted,

    // Model events
    /// Model used
    ModelUsed,

    // Embedding events
    /// Embedding generation requested
    EmbeddingGenerationRequested,
    /// Embedding generation completed
    EmbeddingGenerationCompleted,
    /// Embedding generation failed
    EmbeddingGenerationFailed,

    // Control events
    /// Control message received
    ControlMessage,
}

/// Platform-specific event type prefix
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum PlatformPrefix {
    /// Discord platform
    Discord,
    /// Telegram platform
    Telegram,
    /// X platform
    X,
}

/// Base payload interface for all events
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPayload {
    /// Source of the event
    pub source: String,
    /// Additional data
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Payload for world-related events
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldPayload {
    /// Base payload
    #[serde(flatten)]
    pub base: EventPayload,
    /// World data
    pub world: World,
    /// Rooms in the world
    pub rooms: Vec<Room>,
    /// Entities in the world
    pub entities: Vec<Entity>,
}

/// Payload for entity-related events
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityPayload {
    /// Base payload
    #[serde(flatten)]
    pub base: EventPayload,
    /// Entity ID
    pub entity_id: UUID,
    /// World ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world_id: Option<UUID>,
    /// Room ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<UUID>,
    /// Entity metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<EntityEventMetadata>,
}

/// Metadata for entity events
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityEventMetadata {
    /// Original platform ID
    pub original_id: String,
    /// Username
    pub username: String,
    /// Display name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Additional data
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Payload for message-related events
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePayload {
    /// Base payload
    #[serde(flatten)]
    pub base: EventPayload,
    /// Message memory
    pub message: Memory,
}

/// Payload for channel cleared events
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelClearedPayload {
    /// Base payload
    #[serde(flatten)]
    pub base: EventPayload,
    /// Room ID
    pub room_id: UUID,
    /// Channel ID
    pub channel_id: String,
    /// Number of memories cleared
    pub memory_count: usize,
}

/// Payload for invoke events
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvokePayload {
    /// Base payload
    #[serde(flatten)]
    pub base: EventPayload,
    /// World ID
    pub world_id: UUID,
    /// User ID
    pub user_id: String,
    /// Room ID
    pub room_id: UUID,
}

/// Run status
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    /// Run started
    Started,
    /// Run completed
    Completed,
    /// Run timed out
    Timeout,
}

/// Payload for run events
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventPayload {
    /// Base payload
    #[serde(flatten)]
    pub base: EventPayload,
    /// Run ID
    pub run_id: UUID,
    /// Message ID
    pub message_id: UUID,
    /// Room ID
    pub room_id: UUID,
    /// Entity ID
    pub entity_id: UUID,
    /// Start time
    pub start_time: i64,
    /// Run status
    pub status: RunStatus,
    /// End time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<i64>,
    /// Duration in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<i64>,
    /// Error message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Payload for action events
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionEventPayload {
    /// Base payload
    #[serde(flatten)]
    pub base: EventPayload,
    /// Room ID
    pub room_id: UUID,
    /// World ID
    pub world: UUID,
    /// Content
    pub content: Content,
    /// Message ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<UUID>,
}

/// Payload for evaluator events
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatorEventPayload {
    /// Base payload
    #[serde(flatten)]
    pub base: EventPayload,
    /// Evaluator ID
    pub evaluator_id: UUID,
    /// Evaluator name
    pub evaluator_name: String,
    /// Start time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_time: Option<i64>,
    /// Whether completed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed: Option<bool>,
    /// Error message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Payload for model events
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEventPayload {
    /// Base payload
    #[serde(flatten)]
    pub base: EventPayload,
    /// Model provider
    pub provider: String,
    /// Model type
    #[serde(rename = "type")]
    pub model_type: String,
    /// Prompt
    pub prompt: String,
    /// Token usage
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenUsage>,
}

/// Token usage information
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    /// Prompt tokens
    pub prompt: i32,
    /// Completion tokens
    pub completion: i32,
    /// Total tokens
    pub total: i32,
}

/// Payload for embedding generation events
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingGenerationPayload {
    /// Base payload
    #[serde(flatten)]
    pub base: EventPayload,
    /// Memory being embedded
    pub memory: Memory,
    /// Priority level
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<EmbeddingPriority>,
    /// Retry count
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_count: Option<i32>,
    /// Max retries
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_retries: Option<i32>,
    /// Generated embedding
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding: Option<Vec<f32>>,
    /// Error if failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Run ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<UUID>,
}

/// Embedding priority levels
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EmbeddingPriority {
    /// High priority
    High,
    /// Normal priority
    Normal,
    /// Low priority
    Low,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_type_serialization() {
        let event = EventType::MessageReceived;
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(json, "\"MESSAGE_RECEIVED\"");
    }

    #[test]
    fn test_run_status_serialization() {
        let status = RunStatus::Completed;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"completed\"");
    }
}
