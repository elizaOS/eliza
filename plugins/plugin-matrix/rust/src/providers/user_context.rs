//! User context provider for Matrix plugin.

use crate::types::{get_matrix_localpart, get_matrix_user_display_name, MatrixUserInfo};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// User context data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserContextData {
    pub user_id: String,
    pub display_name: String,
    pub localpart: String,
    pub avatar_url: Option<String>,
}

/// User context provider result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserContextProviderResult {
    pub data: UserContextData,
    pub values: HashMap<String, serde_json::Value>,
    pub text: String,
}

/// Get the current Matrix user context.
pub fn get_user_context(
    sender: &MatrixUserInfo,
    agent_name: &str,
) -> UserContextProviderResult {
    let display_name = get_matrix_user_display_name(sender);
    let localpart = get_matrix_localpart(&sender.user_id).to_string();

    let response_text = format!(
        "{} is talking to {} ({}) on Matrix.",
        agent_name, display_name, sender.user_id
    );

    let data = UserContextData {
        user_id: sender.user_id.clone(),
        display_name: display_name.clone(),
        localpart: localpart.clone(),
        avatar_url: sender.avatar_url.clone(),
    };

    let mut values = HashMap::new();
    values.insert("user_id".to_string(), serde_json::json!(&sender.user_id));
    values.insert("display_name".to_string(), serde_json::json!(&display_name));
    values.insert("localpart".to_string(), serde_json::json!(&localpart));

    UserContextProviderResult {
        data,
        values,
        text: response_text,
    }
}
