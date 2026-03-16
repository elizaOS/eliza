//! Chat context provider for the BlueBubbles plugin.

use crate::service::BlueBubblesService;
use crate::types::{extract_handle_from_chat_guid, BlueBubblesChatType};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Chat context data.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BlueBubblesChatContextData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_guid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_type: Option<String>,
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    pub supports_reactions: bool,
    pub supports_effects: bool,
    pub supports_edit: bool,
    pub supports_reply: bool,
}

/// Chat context result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatContextResult {
    pub data: BlueBubblesChatContextData,
    pub values: HashMap<String, String>,
    pub text: String,
}

/// Get chat context.
pub fn get_chat_context(
    service: &BlueBubblesService,
    chat_guid: Option<&str>,
    handle: Option<&str>,
    display_name: Option<&str>,
    agent_name: Option<&str>,
) -> ChatContextResult {
    let agent_name = agent_name.unwrap_or("The agent");

    if !service.is_connected() {
        return ChatContextResult {
            data: BlueBubblesChatContextData {
                connected: false,
                ..Default::default()
            },
            values: HashMap::new(),
            text: String::new(),
        };
    }

    // Determine chat type from GUID
    let (chat_type, chat_description) = if let Some(guid) = chat_guid {
        if guid.contains(";+;") {
            let desc = display_name
                .map(|n| format!("group chat \"{}\"", n))
                .unwrap_or_else(|| "a group chat".to_string());
            ("group".to_string(), desc)
        } else {
            let extracted = extract_handle_from_chat_guid(guid);
            let desc = extracted
                .as_ref()
                .map(|h| format!("direct message with {}", h))
                .or_else(|| handle.map(|h| format!("direct message with {}", h)))
                .unwrap_or_else(|| "a direct message".to_string());
            ("direct".to_string(), desc)
        }
    } else if let Some(h) = handle {
        ("direct".to_string(), format!("direct message with {}", h))
    } else {
        ("direct".to_string(), "an iMessage conversation".to_string())
    };

    let response_text = format!(
        "{} is chatting via iMessage (BlueBubbles) in {}. \
         This channel supports reactions, effects (slam, balloons, confetti, etc.), \
         editing, and replying to messages.",
        agent_name, chat_description
    );

    let mut values = HashMap::new();
    if let Some(guid) = chat_guid {
        values.insert("chatGuid".to_string(), guid.to_string());
    }
    if let Some(h) = handle {
        values.insert("handle".to_string(), h.to_string());
    }
    if let Some(dn) = display_name {
        values.insert("displayName".to_string(), dn.to_string());
    }
    values.insert("chatType".to_string(), chat_type.clone());

    ChatContextResult {
        data: BlueBubblesChatContextData {
            chat_guid: chat_guid.map(String::from),
            handle: handle.map(String::from),
            display_name: display_name.map(String::from),
            chat_type: Some(chat_type),
            connected: true,
            platform: Some("bluebubbles".to_string()),
            supports_reactions: true,
            supports_effects: true,
            supports_edit: true,
            supports_reply: true,
        },
        values,
        text: response_text,
    }
}

/// Provider name.
pub const CHAT_CONTEXT_PROVIDER_NAME: &str = "bluebubblesChatContext";

/// Provider description.
pub const CHAT_CONTEXT_PROVIDER_DESCRIPTION: &str =
    "Provides information about the current BlueBubbles/iMessage chat context";
