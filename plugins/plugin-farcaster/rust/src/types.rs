#![allow(missing_docs)]

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum EmbedType {
    Image,
    Video,
    Audio,
    Url,
    Cast,
    Frame,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum FarcasterMessageType {
    #[serde(rename = "CAST")]
    #[default]
    Cast,
    #[serde(rename = "REPLY")]
    Reply,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FarcasterEventType {
    #[serde(rename = "FARCASTER_CAST_GENERATED")]
    CastGenerated,
    #[serde(rename = "FARCASTER_MENTION_RECEIVED")]
    MentionReceived,
    #[serde(rename = "FARCASTER_THREAD_CAST_CREATED")]
    ThreadCastCreated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub fid: u64,
    pub name: String,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pfp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl Profile {
    pub fn new(fid: u64, username: String) -> Self {
        Self {
            fid,
            name: String::new(),
            username,
            pfp: None,
            bio: None,
            url: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EmbedMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_fid: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CastEmbed {
    #[serde(rename = "type")]
    pub embed_type: EmbedType,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cast_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<EmbedMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CastParent {
    pub hash: String,
    pub fid: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CastStats {
    pub recasts: u32,
    pub replies: u32,
    pub likes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cast {
    pub hash: String,
    pub author_fid: u64,
    pub text: String,
    pub profile: Profile,
    pub timestamp: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<CastParent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<CastStats>,
    #[serde(default)]
    pub embeds: Vec<CastEmbed>,
}

impl Cast {
    pub fn is_reply(&self) -> bool {
        self.in_reply_to.is_some()
    }

    pub fn message_type(&self) -> FarcasterMessageType {
        if self.is_reply() {
            FarcasterMessageType::Reply
        } else {
            FarcasterMessageType::Cast
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CastId {
    pub hash: String,
    pub fid: u64,
}

impl CastId {
    pub fn new(hash: impl Into<String>, fid: u64) -> Self {
        Self {
            hash: hash.into(),
            fid,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FidRequest {
    pub fid: u64,
    pub page_size: u32,
}

impl FidRequest {
    pub fn new(fid: u64, page_size: u32) -> Self {
        Self { fid, page_size }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastCast {
    pub hash: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendCastParams {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<CastId>,
}

impl SendCastParams {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            in_reply_to: None,
        }
    }

    pub fn with_reply_to(mut self, hash: impl Into<String>, fid: u64) -> Self {
        self.in_reply_to = Some(CastId::new(hash, fid));
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendCastResponse {
    pub hash: String,
    pub author_fid: u64,
    pub text: String,
    pub timestamp: DateTime<Utc>,
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetMentionsResponse {
    pub mentions: Vec<Cast>,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetTimelineResponse {
    pub timeline: Vec<Cast>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookAuthor {
    pub fid: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookCastData {
    pub hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<WebhookAuthor>,
    #[serde(default)]
    pub mentioned_profiles: Vec<WebhookAuthor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_author: Option<WebhookAuthor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NeynarWebhookData {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<WebhookCastData>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_profile_creation() {
        let profile = Profile::new(12345, "testuser".to_string());
        assert_eq!(profile.fid, 12345);
        assert_eq!(profile.username, "testuser");
    }

    #[test]
    fn test_cast_is_reply() {
        let profile = Profile::new(12345, "test".to_string());

        let cast = Cast {
            hash: "0xabc".to_string(),
            author_fid: 12345,
            text: "Hello".to_string(),
            profile: profile.clone(),
            timestamp: Utc::now(),
            thread_id: None,
            in_reply_to: None,
            stats: None,
            embeds: vec![],
        };
        assert!(!cast.is_reply());
        assert_eq!(cast.message_type(), FarcasterMessageType::Cast);

        let reply = Cast {
            hash: "0xdef".to_string(),
            author_fid: 12345,
            text: "Reply".to_string(),
            profile,
            timestamp: Utc::now(),
            thread_id: None,
            in_reply_to: Some(CastParent {
                hash: "0xabc".to_string(),
                fid: 54321,
            }),
            stats: None,
            embeds: vec![],
        };
        assert!(reply.is_reply());
        assert_eq!(reply.message_type(), FarcasterMessageType::Reply);
    }

    #[test]
    fn test_cast_id() {
        let id = CastId::new("0xabc", 12345);
        assert_eq!(id.hash, "0xabc");
        assert_eq!(id.fid, 12345);
    }
}
