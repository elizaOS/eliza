//! Channel state provider for Slack.

use crate::service::SlackService;
use crate::types::SlackChannelType;
use serde::{Deserialize, Serialize};

/// Provider name
pub const CHANNEL_STATE_PROVIDER: &str = "slackChannelState";

/// Provider description
pub const CHANNEL_STATE_DESCRIPTION: &str = "Provides information about the current Slack channel context";

/// Channel state data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelStateData {
    pub channel_type: String,
    pub workspace_name: String,
    pub channel_name: String,
    pub channel_id: String,
    pub thread_ts: Option<String>,
    pub is_thread: bool,
    pub topic: Option<String>,
    pub purpose: Option<String>,
    pub is_private: Option<bool>,
    pub num_members: Option<i32>,
}

/// Channel state result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelStateResult {
    pub data: ChannelStateData,
    pub values: ChannelStateValues,
    pub text: String,
}

/// Channel state values for template substitution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelStateValues {
    pub channel_type: String,
    pub workspace_name: String,
    pub channel_name: String,
    pub channel_id: String,
    pub is_thread: bool,
}

/// Get channel state
pub async fn get_channel_state(
    service: &SlackService,
    channel_id: &str,
    thread_ts: Option<&str>,
    agent_name: &str,
    sender_name: &str,
) -> Result<ChannelStateResult, String> {
    let channel = service
        .get_channel(channel_id)
        .await
        .map_err(|e| e.to_string())?;

    let channel_type = channel.channel_type();
    let channel_type_str = match channel_type {
        SlackChannelType::Im => "DM",
        SlackChannelType::Mpim => "GROUP_DM",
        SlackChannelType::Group => "PRIVATE_CHANNEL",
        SlackChannelType::Channel => "PUBLIC_CHANNEL",
    };

    let channel_name = channel.name.clone();
    let is_thread = thread_ts.is_some();

    let mut response_text = match channel_type {
        SlackChannelType::Im => {
            format!(
                "{} is currently in a direct message conversation with {} on Slack. {} should engage in conversation, responding to messages that are addressed to them.",
                agent_name, sender_name, agent_name
            )
        }
        SlackChannelType::Mpim => {
            format!(
                "{} is currently in a group direct message on Slack. {} should be aware that multiple people can see this conversation.",
                agent_name, agent_name
            )
        }
        _ => {
            if is_thread {
                format!(
                    "{} is currently in a thread within the channel #{} on Slack.\n{} should keep responses focused on the thread topic and be mindful of thread etiquette.",
                    agent_name, channel_name, agent_name
                )
            } else {
                format!(
                    "{} is currently having a conversation in the Slack channel #{}.\n{} is in a channel with other users and should only participate when directly addressed or when the conversation is relevant to them.",
                    agent_name, channel_name, agent_name
                )
            }
        }
    };

    if let Some(ref topic) = channel.topic {
        if !topic.value.is_empty() {
            response_text.push_str(&format!("\nChannel topic: {}", topic.value));
        }
    }

    if let Some(ref purpose) = channel.purpose {
        if !purpose.value.is_empty() {
            response_text.push_str(&format!("\nChannel purpose: {}", purpose.value));
        }
    }

    if let Some(ts) = thread_ts {
        response_text.push_str(&format!("\nThis is a threaded conversation (thread timestamp: {}).", ts));
    }

    Ok(ChannelStateResult {
        data: ChannelStateData {
            channel_type: channel_type_str.to_string(),
            workspace_name: String::new(), // Would need to be passed in
            channel_name: channel_name.clone(),
            channel_id: channel_id.to_string(),
            thread_ts: thread_ts.map(String::from),
            is_thread,
            topic: channel.topic.map(|t| t.value),
            purpose: channel.purpose.map(|p| p.value),
            is_private: Some(channel.is_private),
            num_members: channel.num_members,
        },
        values: ChannelStateValues {
            channel_type: channel_type_str.to_string(),
            workspace_name: String::new(),
            channel_name,
            channel_id: channel_id.to_string(),
            is_thread,
        },
        text: response_text,
    })
}
