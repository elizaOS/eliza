//! User context provider for Google Chat plugin.

use crate::types::{extract_resource_id, get_user_display_name, GoogleChatUser};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// User context data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserContextData {
    pub user_name: String,
    pub user_id: String,
    pub display_name: String,
    pub email: Option<String>,
    pub user_type: String,
    pub is_bot: bool,
}

/// User context provider result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserContextProviderResult {
    pub data: UserContextData,
    pub values: HashMap<String, serde_json::Value>,
    pub text: String,
}

/// Get the current Google Chat user context.
pub fn get_user_context(
    sender: &GoogleChatUser,
    agent_name: &str,
) -> UserContextProviderResult {
    let display_name = get_user_display_name(sender);
    let user_id = extract_resource_id(&sender.name).to_string();
    let user_type = sender.user_type.clone().unwrap_or_else(|| "HUMAN".to_string());
    let is_bot = user_type == "BOT";

    let mut response_text = format!("{} is talking to {}", agent_name, display_name);
    if let Some(ref email) = sender.email {
        response_text.push_str(&format!(" ({})", email));
    }
    response_text.push_str(" on Google Chat.");

    if is_bot {
        response_text.push_str(" This user is a bot.");
    }

    let data = UserContextData {
        user_name: sender.name.clone(),
        user_id: user_id.clone(),
        display_name: display_name.clone(),
        email: sender.email.clone(),
        user_type: user_type.clone(),
        is_bot,
    };

    let mut values = HashMap::new();
    values.insert("user_name".to_string(), serde_json::json!(&sender.name));
    values.insert("user_id".to_string(), serde_json::json!(&user_id));
    values.insert("display_name".to_string(), serde_json::json!(&display_name));
    if let Some(ref email) = sender.email {
        values.insert("email".to_string(), serde_json::json!(email));
    }

    UserContextProviderResult {
        data,
        values,
        text: response_text,
    }
}
