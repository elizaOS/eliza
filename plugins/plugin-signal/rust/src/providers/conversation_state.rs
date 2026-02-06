//! Conversation state provider for Signal plugin.

use crate::service::SignalService;
use crate::types::get_signal_contact_display_name;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

/// Room information structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomInfo {
    pub channel_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

/// Conversation state data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationStateData {
    pub room: Option<RoomInfo>,
    pub conversation_type: String,
    pub contact_name: String,
    pub group_name: String,
    pub channel_id: String,
    pub is_group: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_number: Option<String>,
}

/// Conversation state values (simple key-value)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationStateValues {
    pub conversation_type: String,
    pub contact_name: String,
    pub group_name: String,
    pub channel_id: String,
    pub is_group: bool,
}

/// Conversation state provider result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationStateResult {
    pub data: ConversationStateData,
    pub values: ConversationStateValues,
    pub text: String,
}

impl Default for ConversationStateResult {
    fn default() -> Self {
        Self {
            data: ConversationStateData {
                room: None,
                conversation_type: "unknown".to_string(),
                contact_name: String::new(),
                group_name: String::new(),
                channel_id: String::new(),
                is_group: false,
                account_number: None,
            },
            values: ConversationStateValues {
                conversation_type: "unknown".to_string(),
                contact_name: String::new(),
                group_name: String::new(),
                channel_id: String::new(),
                is_group: false,
            },
            text: String::new(),
        }
    }
}

/// Get the current Signal conversation state
pub async fn get_conversation_state(
    service: Arc<SignalService>,
    room: Option<RoomInfo>,
    agent_name: &str,
    sender_name: &str,
) -> ConversationStateResult {
    let room = match room {
        Some(r) => r,
        None => return ConversationStateResult::default(),
    };

    let channel_id = room.channel_id.clone();
    let is_group = room
        .metadata
        .get("is_group")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut conversation_type = String::new();
    let mut contact_name = String::new();
    let mut group_name = String::new();
    let mut response_text = String::new();

    if is_group {
        conversation_type = "GROUP".to_string();

        let group_id = room
            .metadata
            .get("group_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        group_name = if let Some(group) = service.get_cached_group(group_id).await {
            group.name
        } else {
            room.name.unwrap_or_else(|| "Unknown Group".to_string())
        };

        response_text = format!(
            "{} is currently in a Signal group chat: \"{}\".",
            agent_name, group_name
        );
        response_text.push_str(&format!(
            "\n{} should be aware that multiple people can see this conversation and should participate when relevant.",
            agent_name
        ));

        if let Some(group) = service.get_cached_group(group_id).await {
            if let Some(desc) = group.description {
                response_text.push_str(&format!("\nGroup description: {}", desc));
            }
        }
    } else {
        conversation_type = "DM".to_string();

        contact_name = if let Some(contact) = service.get_contact(&channel_id).await {
            get_signal_contact_display_name(&contact)
        } else {
            sender_name.to_string()
        };

        response_text = format!(
            "{} is currently in a direct message conversation with {} on Signal.",
            agent_name, contact_name
        );
        response_text.push_str(&format!(
            "\n{} should engage naturally in conversation, responding to messages addressed to them.",
            agent_name
        ));
    }

    response_text.push_str(
        "\n\nSignal is an encrypted messaging platform, so all messages are secure and private.",
    );

    ConversationStateResult {
        data: ConversationStateData {
            room: Some(room),
            conversation_type: conversation_type.clone(),
            contact_name: contact_name.clone(),
            group_name: group_name.clone(),
            channel_id: channel_id.clone(),
            is_group,
            account_number: Some(service.get_account_number().to_string()),
        },
        values: ConversationStateValues {
            conversation_type,
            contact_name,
            group_name,
            channel_id,
            is_group,
        },
        text: response_text,
    }
}

/// Provider metadata
pub const PROVIDER_NAME: &str = "signalConversationState";
pub const PROVIDER_DESCRIPTION: &str =
    "Provides information about the current Signal conversation context";
