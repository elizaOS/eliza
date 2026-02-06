//! User context provider for Twitch plugin.

use crate::types::{get_twitch_user_display_name, TwitchUserInfo};
use serde::{Deserialize, Serialize};

/// User context data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserContextData {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub is_broadcaster: bool,
    pub is_moderator: bool,
    pub is_vip: bool,
    pub is_subscriber: bool,
    pub roles: Vec<String>,
    pub color: Option<String>,
}

/// User context values (simple key-value)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserContextValues {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub role_text: String,
    pub is_broadcaster: bool,
    pub is_moderator: bool,
}

/// User context provider result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserContextResult {
    pub data: UserContextData,
    pub values: UserContextValues,
    pub text: String,
}

/// Get the current Twitch user context
pub fn get_user_context(user: &TwitchUserInfo, agent_name: &str) -> UserContextResult {
    let display_name = get_twitch_user_display_name(user);

    let mut roles = Vec::new();
    if user.is_broadcaster {
        roles.push("broadcaster".to_string());
    }
    if user.is_moderator {
        roles.push("moderator".to_string());
    }
    if user.is_vip {
        roles.push("VIP".to_string());
    }
    if user.is_subscriber {
        roles.push("subscriber".to_string());
    }

    let role_text = if roles.is_empty() {
        "viewer".to_string()
    } else {
        roles.join(", ")
    };

    let mut text = format!(
        "{} is talking to {} ({}) in Twitch chat.",
        agent_name, display_name, role_text
    );

    if user.is_broadcaster {
        text.push_str(&format!(" {} is the channel owner/broadcaster.", display_name));
    } else if user.is_moderator {
        text.push_str(&format!(" {} is a channel moderator.", display_name));
    }

    UserContextResult {
        data: UserContextData {
            user_id: user.user_id.clone(),
            username: user.username.clone(),
            display_name: display_name.clone(),
            is_broadcaster: user.is_broadcaster,
            is_moderator: user.is_moderator,
            is_vip: user.is_vip,
            is_subscriber: user.is_subscriber,
            roles,
            color: user.color.clone(),
        },
        values: UserContextValues {
            user_id: user.user_id.clone(),
            username: user.username.clone(),
            display_name,
            role_text,
            is_broadcaster: user.is_broadcaster,
            is_moderator: user.is_moderator,
        },
        text,
    }
}

/// Provider metadata
pub const PROVIDER_NAME: &str = "twitchUserContext";
pub const PROVIDER_DESCRIPTION: &str =
    "Provides information about the Twitch user in the current conversation";
