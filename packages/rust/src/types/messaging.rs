//! Messaging types for elizaOS
//!
//! Contains messaging-related types for agent communication.

use serde::{Deserialize, Serialize};

use super::primitives::{Content, UUID};

/// Target information for sending messages
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetInfo {
    /// Target type
    #[serde(rename = "type")]
    pub target_type: TargetType,
    /// Room ID (for room targets)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<UUID>,
    /// Entity ID (for entity targets)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<UUID>,
    /// Channel ID (for external platforms)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// Platform source (e.g., "discord", "telegram")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Target type for message sending
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TargetType {
    /// Send to a room
    Room,
    /// Send to an entity
    Entity,
    /// Send to a channel
    Channel,
}

/// Control message for runtime control
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlMessage {
    /// Message type
    #[serde(rename = "type")]
    pub message_type: ControlMessageType,
    /// Message data
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// Control message types
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ControlMessageType {
    /// Pause processing
    Pause,
    /// Resume processing
    Resume,
    /// Stop the agent
    Stop,
    /// Restart the agent
    Restart,
    /// Update configuration
    UpdateConfig,
}

/// Message queue item
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageQueueItem {
    /// Message ID
    pub id: UUID,
    /// Room ID
    pub room_id: UUID,
    /// Message content
    pub content: Content,
    /// Priority (higher = more urgent)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i32>,
    /// Creation timestamp
    pub created_at: i64,
    /// Processing status
    pub status: MessageQueueStatus,
}

/// Message queue status
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MessageQueueStatus {
    /// Waiting to be processed
    Pending,
    /// Currently being processed
    Processing,
    /// Successfully processed
    Completed,
    /// Failed to process
    Failed,
}

/// Send handler function type (represented as a name for serialization)
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendHandlerInfo {
    /// Handler source/platform
    pub source: String,
    /// Whether the handler is active
    pub active: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_target_info_serialization() {
        let target = TargetInfo {
            target_type: TargetType::Room,
            room_id: Some(UUID::new_v4()),
            entity_id: None,
            channel_id: None,
            source: Some("discord".to_string()),
        };

        let json = serde_json::to_string(&target).unwrap();
        assert!(json.contains("\"type\":\"room\""));
        assert!(json.contains("\"source\":\"discord\""));
    }

    #[test]
    fn test_control_message_serialization() {
        let msg = ControlMessage {
            message_type: ControlMessageType::Pause,
            data: None,
        };

        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"PAUSE\""));
    }
}
