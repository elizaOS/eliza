//! Get user info action

use async_trait::async_trait;

use super::{ActionContext, ActionResult, DiscordAction};
use crate::error::Result;
use crate::DiscordService;

/// Action to get detailed information about a Discord user
pub struct GetUserInfoAction;

#[async_trait]
impl DiscordAction for GetUserInfoAction {
    fn name(&self) -> &str {
        "GET_USER_INFO"
    }

    fn description(&self) -> &str {
        "Get detailed information about a Discord user including their roles, \
        join date, and permissions."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "USER_INFO",
            "WHO_IS",
            "ABOUT_USER",
            "USER_DETAILS",
            "MEMBER_INFO",
            "CHECK_USER",
        ]
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let source = context
            .message
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        Ok(source == "discord")
    }

    async fn handler(
        &self,
        context: &ActionContext,
        service: &DiscordService,
    ) -> Result<ActionResult> {
        let text = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        // Parse user identifier from message
        let user_identifier = service.extract_user_identifier(text).await?;

        let user_identifier = match user_identifier {
            Some(id) => id,
            None => {
                return Ok(ActionResult::failure(
                    "I couldn't understand which user you want information about. \
                    Please specify a username or mention.",
                ))
            }
        };

        let guild_id = match &context.guild_id {
            Some(id) => id,
            None => {
                return Ok(ActionResult::failure(
                    "I can only get user info in a server, not in DMs.",
                ))
            }
        };

        // Get user info
        let user_info = service.get_member_info(guild_id, &user_identifier).await?;

        let user_info = match user_info {
            Some(info) => info,
            None => {
                return Ok(ActionResult::failure(format!(
                    "I couldn't find a user with the identifier \"{}\" in this server.",
                    user_identifier
                )))
            }
        };

        // Format the response
        let formatted = service.format_user_info(&user_info);

        let user_id = user_info.get("id").and_then(|i| i.as_str()).unwrap_or("");
        let username = user_info
            .get("username")
            .and_then(|u| u.as_str())
            .unwrap_or("");

        Ok(ActionResult::success_with_data(
            formatted,
            serde_json::json!({
                "user_id": user_id,
                "username": username,
            }),
        ))
    }
}
