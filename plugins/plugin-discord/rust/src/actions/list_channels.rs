//! List channels action

use async_trait::async_trait;

use super::{ActionContext, ActionResult, DiscordAction};
use crate::error::Result;
use crate::DiscordService;

/// Action to list all channels the bot is listening to
pub struct ListChannelsAction;

#[async_trait]
impl DiscordAction for ListChannelsAction {
    fn name(&self) -> &str {
        "LIST_CHANNELS"
    }

    fn description(&self) -> &str {
        "Lists all Discord channels the bot is currently listening to and responding in."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "SHOW_CHANNELS",
            "LIST_LISTENING_CHANNELS",
            "SHOW_MONITORED_CHANNELS",
            "GET_CHANNELS",
            "WHICH_CHANNELS",
            "CHANNELS_LIST",
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
        _context: &ActionContext,
        service: &DiscordService,
    ) -> Result<ActionResult> {
        // Get all allowed channels
        let allowed_channel_ids = service.get_allowed_channels();

        if allowed_channel_ids.is_empty() {
            return Ok(ActionResult::success_with_data(
                "I'm currently listening to all channels (no restrictions are set).",
                serde_json::json!({
                    "channels": [],
                    "unrestricted": true,
                }),
            ));
        }

        // Fetch channel information
        let mut channel_infos = Vec::new();
        for channel_id in &allowed_channel_ids {
            match service.get_channel_info(channel_id).await {
                Ok(Some(info)) => channel_infos.push(info),
                _ => {
                    channel_infos.push(serde_json::json!({
                        "id": channel_id,
                        "name": "Unknown",
                        "server": "Unknown or Deleted",
                    }));
                }
            }
        }

        // Group by server
        let mut channels_by_server: std::collections::HashMap<String, Vec<serde_json::Value>> =
            std::collections::HashMap::new();

        for channel in &channel_infos {
            let server = channel
                .get("server")
                .and_then(|s| s.as_str())
                .unwrap_or("Unknown")
                .to_string();
            channels_by_server
                .entry(server)
                .or_default()
                .push(channel.clone());
        }

        // Format response
        let mut response_lines = vec![
            format!(
                "I'm currently listening to {} channel{}:",
                channel_infos.len(),
                if channel_infos.len() != 1 { "s" } else { "" }
            ),
            String::new(),
        ];

        for (server_name, channels) in &channels_by_server {
            response_lines.push(format!("**{}**", server_name));
            for channel in channels {
                let name = channel
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("Unknown");
                let mention = channel
                    .get("mention")
                    .or_else(|| channel.get("id"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("");
                response_lines.push(format!("• {} ({})", name, mention));
            }
            response_lines.push(String::new());
        }

        if service.has_env_channels() {
            response_lines.push(
                "*Some channels are configured in environment settings \
                and cannot be removed dynamically.*"
                    .to_string(),
            );
        }

        Ok(ActionResult::success_with_data(
            response_lines.join("\n").trim().to_string(),
            serde_json::json!({
                "channels": channel_infos,
                "count": channel_infos.len(),
            }),
        ))
    }
}
