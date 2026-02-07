//! Member list provider for Slack.

use crate::service::SlackService;
use serde::{Deserialize, Serialize};

/// Provider name
pub const MEMBER_LIST_PROVIDER: &str = "slackMemberList";

/// Provider description
pub const MEMBER_LIST_DESCRIPTION: &str = "Provides information about members in the current Slack channel";

/// Member info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberInfo {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub is_bot: bool,
    pub is_admin: bool,
}

/// Member list data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberListData {
    pub channel_id: String,
    pub channel_name: String,
    pub member_count: usize,
    pub members: Vec<MemberInfo>,
    pub has_more_members: bool,
}

/// Member list result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberListResult {
    pub data: MemberListData,
    pub text: String,
}

/// Get member list (simplified - would need full implementation with conversations.members API)
pub async fn get_member_list(
    service: &SlackService,
    channel_id: &str,
) -> Result<MemberListResult, String> {
    let channel = service
        .get_channel(channel_id)
        .await
        .map_err(|e| e.to_string())?;

    let channel_name = channel.name.clone();
    let member_count = channel.num_members.unwrap_or(0) as usize;

    // Note: Full implementation would call conversations.members and users.info
    // This is a simplified version
    let response_text = format!(
        "Members in #{} ({} total members)",
        channel_name, member_count
    );

    Ok(MemberListResult {
        data: MemberListData {
            channel_id: channel_id.to_string(),
            channel_name,
            member_count,
            members: vec![], // Would be populated by conversations.members
            has_more_members: false,
        },
        text: response_text,
    })
}
