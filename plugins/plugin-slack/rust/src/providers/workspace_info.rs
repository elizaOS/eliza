//! Workspace info provider for Slack.

use crate::service::SlackService;
use serde::{Deserialize, Serialize};

/// Provider name
pub const WORKSPACE_INFO_PROVIDER: &str = "slackWorkspaceInfo";

/// Provider description
pub const WORKSPACE_INFO_DESCRIPTION: &str = "Provides information about the Slack workspace";

/// Workspace info data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInfoData {
    pub team_id: Option<String>,
    pub bot_user_id: Option<String>,
    pub workspace_name: String,
    pub domain: String,
    pub is_connected: bool,
    pub public_channel_count: usize,
    pub private_channel_count: usize,
    pub member_channel_count: usize,
    pub has_channel_restrictions: bool,
}

/// Workspace info result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInfoResult {
    pub data: WorkspaceInfoData,
    pub text: String,
}

/// Get workspace info
pub async fn get_workspace_info(
    service: &SlackService,
    agent_name: &str,
) -> Result<WorkspaceInfoResult, String> {
    let channels = service
        .list_channels(Some("public_channel,private_channel"), None)
        .await
        .map_err(|e| e.to_string())?;

    let public_channels: Vec<_> = channels
        .iter()
        .filter(|ch| !ch.is_private && !ch.is_archived)
        .collect();
    let private_channels: Vec<_> = channels
        .iter()
        .filter(|ch| ch.is_private && !ch.is_archived)
        .collect();
    let member_channels: Vec<_> = channels
        .iter()
        .filter(|ch| ch.is_member && !ch.is_archived)
        .collect();

    let team_id = service.team_id().map(String::from);
    let bot_user_id = service.bot_user_id().map(String::from);
    let is_connected = service.is_connected();

    let mut response_text = format!("{} is connected to the Slack workspace.", agent_name);
    response_text.push_str("\n\nWorkspace statistics:");
    response_text.push_str(&format!("\n- Public channels: {}", public_channels.len()));
    response_text.push_str(&format!("\n- Private channels: {}", private_channels.len()));
    response_text.push_str(&format!(
        "\n- Channels the bot is a member of: {}",
        member_channels.len()
    ));

    Ok(WorkspaceInfoResult {
        data: WorkspaceInfoData {
            team_id,
            bot_user_id,
            workspace_name: String::new(),
            domain: String::new(),
            is_connected,
            public_channel_count: public_channels.len(),
            private_channel_count: private_channels.len(),
            member_channel_count: member_channels.len(),
            has_channel_restrictions: false,
        },
        text: response_text,
    })
}
