//! User context provider for the LINE plugin.

use crate::service::LineService;
use serde::{Deserialize, Serialize};

/// User context data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineUserContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub connected: bool,
}

/// User context response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserContextResponse {
    pub data: LineUserContext,
    pub values: serde_json::Value,
    pub text: String,
}

/// Get the current LINE user context
pub async fn get_user_context(
    service: &LineService,
    user_id: Option<&str>,
    agent_name: Option<&str>,
) -> UserContextResponse {
    let agent = agent_name.unwrap_or("The agent");

    if !service.is_connected().await {
        return UserContextResponse {
            data: LineUserContext {
                user_id: None,
                display_name: None,
                picture_url: None,
                status_message: None,
                language: None,
                connected: false,
            },
            values: serde_json::json!({ "connected": false }),
            text: String::new(),
        };
    }

    let uid = match user_id {
        Some(id) => id,
        None => {
            return UserContextResponse {
                data: LineUserContext {
                    user_id: None,
                    display_name: None,
                    picture_url: None,
                    status_message: None,
                    language: None,
                    connected: true,
                },
                values: serde_json::json!({ "connected": true }),
                text: String::new(),
            }
        }
    };

    // Try to get user profile
    let profile = service.get_user_profile(uid).await;

    match profile {
        Ok(p) => {
            let mut response_text = format!("{} is talking to {} on LINE. ", agent, p.display_name);
            if let Some(status) = &p.status_message {
                response_text += &format!("Their status: \"{}\". ", status);
            }
            if let Some(lang) = &p.language {
                response_text += &format!("Language preference: {}.", lang);
            }

            UserContextResponse {
                data: LineUserContext {
                    user_id: Some(p.user_id.clone()),
                    display_name: Some(p.display_name.clone()),
                    picture_url: p.picture_url.clone(),
                    status_message: p.status_message.clone(),
                    language: p.language.clone(),
                    connected: true,
                },
                values: serde_json::json!({
                    "user_id": p.user_id,
                    "display_name": p.display_name,
                    "language": p.language,
                }),
                text: response_text,
            }
        }
        Err(_) => UserContextResponse {
            data: LineUserContext {
                user_id: Some(uid.to_string()),
                display_name: None,
                picture_url: None,
                status_message: None,
                language: None,
                connected: true,
            },
            values: serde_json::json!({ "user_id": uid }),
            text: format!(
                "{} is talking to a LINE user (ID: {}...).",
                agent,
                &uid[..8.min(uid.len())]
            ),
        },
    }
}

/// Provider metadata
pub const USER_CONTEXT_PROVIDER_NAME: &str = "lineUserContext";
pub const USER_CONTEXT_PROVIDER_DESCRIPTION: &str =
    "Provides information about the LINE user in the current conversation";
