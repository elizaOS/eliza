//! Get user info action for Slack.

use crate::service::SlackService;
use crate::types::is_valid_user_id;
use serde::{Deserialize, Serialize};

/// Action name
pub const GET_USER_INFO_ACTION: &str = "SLACK_GET_USER_INFO";

/// Action similes
pub const GET_USER_INFO_SIMILES: &[&str] = &[
    "GET_SLACK_USER",
    "USER_INFO",
    "SLACK_USER",
    "WHO_IS",
];

/// Action description
pub const GET_USER_INFO_DESCRIPTION: &str = "Get information about a Slack user";

/// Get user info parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetUserInfoParams {
    pub user_id: String,
}

/// Get user info result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetUserInfoResult {
    pub success: bool,
    pub user_id: Option<String>,
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub real_name: Option<String>,
    pub title: Option<String>,
    pub email: Option<String>,
    pub timezone: Option<String>,
    pub is_admin: Option<bool>,
    pub is_owner: Option<bool>,
    pub is_bot: Option<bool>,
    pub status_text: Option<String>,
    pub status_emoji: Option<String>,
    pub avatar: Option<String>,
    pub error: Option<String>,
}

/// Execute the get user info action
pub async fn execute_get_user_info(
    service: &SlackService,
    params: GetUserInfoParams,
) -> GetUserInfoResult {
    if !is_valid_user_id(&params.user_id) {
        return GetUserInfoResult {
            success: false,
            user_id: None,
            name: None,
            display_name: None,
            real_name: None,
            title: None,
            email: None,
            timezone: None,
            is_admin: None,
            is_owner: None,
            is_bot: None,
            status_text: None,
            status_emoji: None,
            avatar: None,
            error: Some("Invalid user ID format".to_string()),
        };
    }

    match service.get_user(&params.user_id).await {
        Ok(user) => GetUserInfoResult {
            success: true,
            user_id: Some(user.id.clone()),
            name: Some(user.name.clone()),
            display_name: Some(user.display_name().to_string()),
            real_name: user.profile.real_name.clone(),
            title: user.profile.title.clone(),
            email: user.profile.email.clone(),
            timezone: user.tz.clone(),
            is_admin: Some(user.is_admin),
            is_owner: Some(user.is_owner),
            is_bot: Some(user.is_bot),
            status_text: user.profile.status_text.clone(),
            status_emoji: user.profile.status_emoji.clone(),
            avatar: user.profile.image_192.clone().or(user.profile.image_72.clone()),
            error: None,
        },
        Err(e) => GetUserInfoResult {
            success: false,
            user_id: None,
            name: None,
            display_name: None,
            real_name: None,
            title: None,
            email: None,
            timezone: None,
            is_admin: None,
            is_owner: None,
            is_bot: None,
            status_text: None,
            status_emoji: None,
            avatar: None,
            error: Some(e.to_string()),
        },
    }
}
