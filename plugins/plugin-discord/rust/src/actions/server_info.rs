//! Server info action

use async_trait::async_trait;

use super::{ActionContext, ActionResult, DiscordAction};
use crate::error::Result;
use crate::DiscordService;

/// Action to get information about the current Discord server
pub struct ServerInfoAction;

#[async_trait]
impl DiscordAction for ServerInfoAction {
    fn name(&self) -> &str {
        "SERVER_INFO"
    }

    fn description(&self) -> &str {
        "Get detailed information about the current Discord server including member count, channels, and roles."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "GUILD_INFO",
            "ABOUT_SERVER",
            "SERVER_DETAILS",
            "SHOW_SERVER_INFO",
            "GET_GUILD_INFO",
        ]
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let source = context
            .message
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if source != "discord" {
            return Ok(false);
        }

        // Requires guild context
        Ok(context.guild_id.is_some())
    }

    async fn handler(
        &self,
        context: &ActionContext,
        service: &DiscordService,
    ) -> Result<ActionResult> {
        let guild_id = match &context.guild_id {
            Some(id) => id,
            None => {
                return Ok(ActionResult::failure(
                    "This command can only be used in a server, not in DMs.",
                ));
            }
        };

        // Get server info
        let server_info = service.get_server_info(guild_id).await?;

        if server_info.is_null() {
            return Ok(ActionResult::failure(
                "I couldn't fetch information about this server.",
            ));
        }

        // Format the response
        let info_text = format_server_info(&server_info);

        Ok(ActionResult::success_with_data(info_text, server_info))
    }
}

fn format_server_info(info: &serde_json::Value) -> String {
    let name = info
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("Unknown");
    let id = info.get("id").and_then(|i| i.as_str()).unwrap_or("Unknown");
    let owner = info
        .get("owner")
        .and_then(|o| o.as_str())
        .unwrap_or("Unknown");
    let created_at = info
        .get("created_at")
        .and_then(|c| c.as_str())
        .unwrap_or("Unknown");
    let member_count = info
        .get("member_count")
        .and_then(|m| m.as_u64())
        .unwrap_or(0);
    let online_count = info
        .get("online_count")
        .and_then(|o| o.as_u64())
        .unwrap_or(0);
    let channel_count = info
        .get("channel_count")
        .and_then(|c| c.as_u64())
        .unwrap_or(0);
    let role_count = info.get("role_count").and_then(|r| r.as_u64()).unwrap_or(0);
    let emoji_count = info
        .get("emoji_count")
        .and_then(|e| e.as_u64())
        .unwrap_or(0);
    let verification_level = info
        .get("verification_level")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown");
    let boost_level = info
        .get("boost_level")
        .and_then(|b| b.as_u64())
        .unwrap_or(0);
    let boost_count = info
        .get("boost_count")
        .and_then(|b| b.as_u64())
        .unwrap_or(0);

    let mut lines = vec![
        "🏛️ **Server Information**".to_string(),
        String::new(),
        format!("**Name:** {}", name),
        format!("**ID:** {}", id),
        format!("**Owner:** {}", owner),
        format!("**Created:** {}", created_at),
        String::new(),
        "📊 **Statistics**".to_string(),
        format!("**Members:** {}", member_count),
        format!("**Online:** {}", online_count),
        format!("**Channels:** {}", channel_count),
        format!("**Roles:** {}", role_count),
        format!("**Emojis:** {}", emoji_count),
        String::new(),
        "⚙️ **Settings**".to_string(),
        format!("**Verification Level:** {}", verification_level),
        format!("**Boost Level:** {}", boost_level),
        format!("**Boost Count:** {}", boost_count),
    ];

    // Add description if available
    if let Some(description) = info.get("description").and_then(|d| d.as_str()) {
        if !description.is_empty() {
            lines.insert(1, format!("*{}*", description));
            lines.insert(2, String::new());
        }
    }

    // Add features if available
    if let Some(features) = info.get("features").and_then(|f| f.as_array()) {
        let feature_strs: Vec<&str> = features
            .iter()
            .take(10)
            .filter_map(|f| f.as_str())
            .collect();

        if !feature_strs.is_empty() {
            lines.push(String::new());
            lines.push("✨ **Features**".to_string());
            lines.push(feature_strs.join(", "));

            if features.len() > 10 {
                lines.push(format!("...and {} more", features.len() - 10));
            }
        }
    }

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_validate_with_guild() {
        let action = ServerInfoAction;
        let context = ActionContext {
            message: json!({
                "source": "discord",
                "content": {
                    "text": "show server info"
                }
            }),
            channel_id: "123456789".to_string(),
            guild_id: Some("987654321".to_string()),
            user_id: "111222333".to_string(),
            state: json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_without_guild() {
        let action = ServerInfoAction;
        let context = ActionContext {
            message: json!({
                "source": "discord",
                "content": {
                    "text": "show server info"
                }
            }),
            channel_id: "123456789".to_string(),
            guild_id: None,
            user_id: "111222333".to_string(),
            state: json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }
}
