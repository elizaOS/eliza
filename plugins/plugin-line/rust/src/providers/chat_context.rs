//! Chat context provider for the LINE plugin.

use crate::service::LineService;
use crate::types::LineChatType;
use serde::{Deserialize, Serialize};

/// Chat context data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineChatContext {
    pub chat_type: String,
    pub chat_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_count: Option<u32>,
    pub connected: bool,
}

/// Chat context response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatContextResponse {
    pub data: LineChatContext,
    pub values: serde_json::Value,
    pub text: String,
}

/// Get the current LINE chat context
pub async fn get_chat_context(
    service: &LineService,
    user_id: Option<&str>,
    group_id: Option<&str>,
    room_id: Option<&str>,
    agent_name: Option<&str>,
) -> ChatContextResponse {
    let agent = agent_name.unwrap_or("The agent");

    if !service.is_connected().await {
        return ChatContextResponse {
            data: LineChatContext {
                chat_type: "user".to_string(),
                chat_id: String::new(),
                user_id: None,
                group_id: None,
                room_id: None,
                chat_name: None,
                member_count: None,
                connected: false,
            },
            values: serde_json::json!({ "connected": false }),
            text: String::new(),
        };
    }

    let mut chat_type = LineChatType::User;
    let mut chat_id = user_id.unwrap_or_default().to_string();
    let mut chat_name = None;
    let mut member_count = None;

    if let Some(gid) = group_id {
        chat_type = LineChatType::Group;
        chat_id = gid.to_string();

        // Try to get group info
        if let Ok(group_info) = service.get_group_info(gid).await {
            chat_name = group_info.group_name;
            member_count = group_info.member_count;
        }
    } else if let Some(rid) = room_id {
        chat_type = LineChatType::Room;
        chat_id = rid.to_string();
    }

    let mut response_text = format!("{} is chatting on LINE ", agent);

    match chat_type {
        LineChatType::User => {
            response_text += "in a direct message conversation.";
        }
        LineChatType::Group => {
            let name = chat_name.clone().unwrap_or_else(|| chat_id.clone());
            response_text += &format!("in group \"{}\".", name);
            if let Some(count) = member_count {
                response_text += &format!(" The group has {} members.", count);
            }
        }
        LineChatType::Room => {
            response_text += "in a multi-person chat room.";
        }
    }

    response_text +=
        " LINE supports text messages, images, locations, rich cards (flex messages), and quick replies.";

    ChatContextResponse {
        data: LineChatContext {
            chat_type: chat_type.to_string(),
            chat_id: chat_id.clone(),
            user_id: user_id.map(String::from),
            group_id: group_id.map(String::from),
            room_id: room_id.map(String::from),
            chat_name: chat_name.clone(),
            member_count,
            connected: true,
        },
        values: serde_json::json!({
            "chat_type": chat_type.to_string(),
            "chat_id": chat_id,
            "chat_name": chat_name,
        }),
        text: response_text,
    }
}

/// Provider metadata
pub const CHAT_CONTEXT_PROVIDER_NAME: &str = "lineChatContext";
pub const CHAT_CONTEXT_PROVIDER_DESCRIPTION: &str =
    "Provides information about the current LINE chat context";
