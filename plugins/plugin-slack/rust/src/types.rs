//! Type definitions for the elizaOS Slack plugin.

use regex::Regex;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Service name constant
pub const SLACK_SERVICE_NAME: &str = "slack";

/// Maximum message length for Slack messages
pub const MAX_SLACK_MESSAGE_LENGTH: usize = 4000;

/// Maximum number of blocks per message
pub const MAX_SLACK_BLOCKS: usize = 50;

/// Maximum file size for uploads (in bytes) - 1GB
pub const MAX_SLACK_FILE_SIZE: u64 = 1024 * 1024 * 1024;

/// Slack-specific event types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SlackEventType {
    MessageReceived,
    MessageSent,
    ReactionAdded,
    ReactionRemoved,
    ChannelJoined,
    ChannelLeft,
    MemberJoinedChannel,
    MemberLeftChannel,
    AppMention,
    SlashCommand,
    FileShared,
    ThreadReply,
}

impl SlackEventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MessageReceived => "SLACK_MESSAGE_RECEIVED",
            Self::MessageSent => "SLACK_MESSAGE_SENT",
            Self::ReactionAdded => "SLACK_REACTION_ADDED",
            Self::ReactionRemoved => "SLACK_REACTION_REMOVED",
            Self::ChannelJoined => "SLACK_CHANNEL_JOINED",
            Self::ChannelLeft => "SLACK_CHANNEL_LEFT",
            Self::MemberJoinedChannel => "SLACK_MEMBER_JOINED_CHANNEL",
            Self::MemberLeftChannel => "SLACK_MEMBER_LEFT_CHANNEL",
            Self::AppMention => "SLACK_APP_MENTION",
            Self::SlashCommand => "SLACK_SLASH_COMMAND",
            Self::FileShared => "SLACK_FILE_SHARED",
            Self::ThreadReply => "SLACK_THREAD_REPLY",
        }
    }
}

/// Slack channel type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SlackChannelType {
    Channel,
    Group,
    Im,
    Mpim,
}

impl SlackChannelType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Channel => "channel",
            Self::Group => "group",
            Self::Im => "im",
            Self::Mpim => "mpim",
        }
    }
}

/// Slack user profile
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SlackUserProfile {
    pub title: Option<String>,
    pub phone: Option<String>,
    pub skype: Option<String>,
    pub real_name: Option<String>,
    pub real_name_normalized: Option<String>,
    pub display_name: Option<String>,
    pub display_name_normalized: Option<String>,
    pub status_text: Option<String>,
    pub status_emoji: Option<String>,
    pub status_expiration: Option<i64>,
    pub avatar_hash: Option<String>,
    pub email: Option<String>,
    pub image_24: Option<String>,
    pub image_32: Option<String>,
    pub image_48: Option<String>,
    pub image_72: Option<String>,
    pub image_192: Option<String>,
    pub image_512: Option<String>,
    pub image_1024: Option<String>,
    pub image_original: Option<String>,
    pub team: Option<String>,
}

/// Slack user information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackUser {
    pub id: String,
    pub name: String,
    pub profile: SlackUserProfile,
    pub team_id: Option<String>,
    #[serde(default)]
    pub deleted: bool,
    pub real_name: Option<String>,
    pub tz: Option<String>,
    pub tz_label: Option<String>,
    pub tz_offset: Option<i32>,
    #[serde(default)]
    pub is_admin: bool,
    #[serde(default)]
    pub is_owner: bool,
    #[serde(default)]
    pub is_primary_owner: bool,
    #[serde(default)]
    pub is_restricted: bool,
    #[serde(default)]
    pub is_ultra_restricted: bool,
    #[serde(default)]
    pub is_bot: bool,
    #[serde(default)]
    pub is_app_user: bool,
    #[serde(default)]
    pub updated: i64,
}

impl SlackUser {
    /// Get the display name for the user
    pub fn display_name(&self) -> &str {
        self.profile
            .display_name
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(self.profile.real_name.as_deref())
            .unwrap_or(&self.name)
    }
}

/// Slack channel topic
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackChannelTopic {
    pub value: String,
    pub creator: String,
    pub last_set: i64,
}

/// Slack channel purpose
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackChannelPurpose {
    pub value: String,
    pub creator: String,
    pub last_set: i64,
}

/// Slack channel information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackChannel {
    pub id: String,
    pub name: String,
    pub created: i64,
    pub creator: String,
    #[serde(default)]
    pub is_channel: bool,
    #[serde(default)]
    pub is_group: bool,
    #[serde(default)]
    pub is_im: bool,
    #[serde(default)]
    pub is_mpim: bool,
    #[serde(default)]
    pub is_private: bool,
    #[serde(default)]
    pub is_archived: bool,
    #[serde(default)]
    pub is_general: bool,
    #[serde(default)]
    pub is_shared: bool,
    #[serde(default)]
    pub is_org_shared: bool,
    #[serde(default)]
    pub is_member: bool,
    pub topic: Option<SlackChannelTopic>,
    pub purpose: Option<SlackChannelPurpose>,
    pub num_members: Option<i32>,
}

impl SlackChannel {
    /// Determine the channel type
    pub fn channel_type(&self) -> SlackChannelType {
        if self.is_im {
            SlackChannelType::Im
        } else if self.is_mpim {
            SlackChannelType::Mpim
        } else if self.is_group || self.is_private {
            SlackChannelType::Group
        } else {
            SlackChannelType::Channel
        }
    }
}

/// Slack file information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackFile {
    pub id: String,
    pub name: String,
    pub title: String,
    pub mimetype: String,
    pub filetype: String,
    pub size: u64,
    pub url_private: String,
    pub url_private_download: Option<String>,
    pub permalink: String,
    pub thumb_64: Option<String>,
    pub thumb_80: Option<String>,
    pub thumb_360: Option<String>,
}

/// Slack reaction information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackReaction {
    pub name: String,
    pub count: i32,
    pub users: Vec<String>,
}

/// Slack message information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub ts: String,
    pub text: String,
    pub subtype: Option<String>,
    pub user: Option<String>,
    pub thread_ts: Option<String>,
    pub reply_count: Option<i32>,
    pub reply_users_count: Option<i32>,
    pub latest_reply: Option<String>,
    pub reactions: Option<Vec<SlackReaction>>,
    pub files: Option<Vec<SlackFile>>,
    pub attachments: Option<Vec<serde_json::Value>>,
    pub blocks: Option<Vec<serde_json::Value>>,
}

/// Slack plugin settings
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SlackSettings {
    pub allowed_channel_ids: Option<Vec<String>>,
    #[serde(default)]
    pub should_ignore_bot_messages: bool,
    #[serde(default)]
    pub should_respond_only_to_mentions: bool,
}

/// Message send options
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SlackMessageSendOptions {
    pub thread_ts: Option<String>,
    pub reply_broadcast: Option<bool>,
    pub unfurl_links: Option<bool>,
    pub unfurl_media: Option<bool>,
    pub mrkdwn: Option<bool>,
    pub attachments: Option<Vec<serde_json::Value>>,
    pub blocks: Option<Vec<serde_json::Value>>,
}

/// Slack plugin errors
#[derive(Debug, Error)]
pub enum SlackError {
    #[error("Slack service is not initialized")]
    ServiceNotInitialized,

    #[error("Slack client is not available")]
    ClientNotAvailable,

    #[error("Missing required configuration: {0}")]
    ConfigurationError(String),

    #[error("Slack API error: {message}")]
    ApiError {
        message: String,
        code: Option<String>,
    },

    #[error("Invalid channel ID: {0}")]
    InvalidChannelId(String),

    #[error("Invalid user ID: {0}")]
    InvalidUserId(String),

    #[error("Invalid message timestamp: {0}")]
    InvalidMessageTs(String),

    #[error("Request failed: {0}")]
    RequestError(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),
}

/// Validate a Slack channel ID format
pub fn is_valid_channel_id(id: &str) -> bool {
    let re = Regex::new(r"^[CGD][A-Za-z0-9]{8,}$").unwrap();
    re.is_match(id)
}

/// Validate a Slack user ID format
pub fn is_valid_user_id(id: &str) -> bool {
    let re = Regex::new(r"^[UW][A-Za-z0-9]{8,}$").unwrap();
    re.is_match(id)
}

/// Validate a Slack team ID format
pub fn is_valid_team_id(id: &str) -> bool {
    let re = Regex::new(r"^T[A-Za-z0-9]{8,}$").unwrap();
    re.is_match(id)
}

/// Validate a Slack message timestamp format
pub fn is_valid_message_ts(ts: &str) -> bool {
    let re = Regex::new(r"^\d+\.\d{6}$").unwrap();
    re.is_match(ts)
}

/// Parse a Slack message link to extract channel and message IDs
pub fn parse_slack_message_link(link: &str) -> Option<(String, String)> {
    let re = Regex::new(r"/archives/([CGD][A-Za-z0-9]+)/p(\d+)").unwrap();
    re.captures(link).map(|caps| {
        let channel_id = caps.get(1).unwrap().as_str().to_string();
        let ts_raw = caps.get(2).unwrap().as_str();
        // Convert: p1234567890123456 -> 1234567890.123456
        let message_ts = format!("{}.{}", &ts_raw[..10], &ts_raw[10..]);
        (channel_id, message_ts)
    })
}

/// Format a message timestamp for use in Slack links
pub fn format_message_ts_for_link(ts: &str) -> String {
    format!("p{}", ts.replace('.', ""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_channel_id() {
        assert!(is_valid_channel_id("C0123456789"));
        assert!(is_valid_channel_id("G0123456789"));
        assert!(is_valid_channel_id("D0123456789"));
        assert!(!is_valid_channel_id("invalid"));
        assert!(!is_valid_channel_id("C123"));
    }

    #[test]
    fn test_valid_user_id() {
        assert!(is_valid_user_id("U0123456789"));
        assert!(is_valid_user_id("W0123456789"));
        assert!(!is_valid_user_id("invalid"));
        assert!(!is_valid_user_id("U123"));
    }

    #[test]
    fn test_valid_message_ts() {
        assert!(is_valid_message_ts("1234567890.123456"));
        assert!(!is_valid_message_ts("invalid"));
        assert!(!is_valid_message_ts("1234567890"));
    }

    #[test]
    fn test_parse_slack_message_link() {
        let link = "https://workspace.slack.com/archives/C12345678901/p1234567890123456";
        let result = parse_slack_message_link(link);
        assert!(result.is_some());
        let (channel_id, message_ts) = result.unwrap();
        assert_eq!(channel_id, "C12345678901");
        assert_eq!(message_ts, "1234567890.123456");
    }
}
