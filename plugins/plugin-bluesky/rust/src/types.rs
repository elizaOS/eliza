#![allow(missing_docs)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlueSkyProfile {
    pub did: String,
    pub handle: String,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(rename = "followersCount", skip_serializing_if = "Option::is_none")]
    pub followers_count: Option<u64>,
    #[serde(rename = "followsCount", skip_serializing_if = "Option::is_none")]
    pub follows_count: Option<u64>,
    #[serde(rename = "postsCount", skip_serializing_if = "Option::is_none")]
    pub posts_count: Option<u64>,
}

impl BlueSkyProfile {
    pub fn new(did: impl Into<String>, handle: impl Into<String>) -> Self {
        Self {
            did: did.into(),
            handle: handle.into(),
            display_name: None,
            description: None,
            avatar: None,
            followers_count: None,
            follows_count: None,
            posts_count: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostRecord {
    #[serde(rename = "$type")]
    pub record_type: String,
    pub text: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlueSkyPost {
    pub uri: String,
    pub cid: String,
    pub author: BlueSkyProfile,
    pub record: PostRecord,
    #[serde(rename = "replyCount", skip_serializing_if = "Option::is_none")]
    pub reply_count: Option<u64>,
    #[serde(rename = "repostCount", skip_serializing_if = "Option::is_none")]
    pub repost_count: Option<u64>,
    #[serde(rename = "likeCount", skip_serializing_if = "Option::is_none")]
    pub like_count: Option<u64>,
    #[serde(rename = "indexedAt")]
    pub indexed_at: String,
}

#[derive(Debug, Clone, Default)]
pub struct TimelineRequest {
    pub algorithm: Option<String>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

impl TimelineRequest {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_limit(mut self, limit: u32) -> Self {
        self.limit = Some(limit);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineFeedItem {
    pub post: BlueSkyPost,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    pub feed: Vec<TimelineFeedItem>,
}

#[derive(Debug, Clone)]
pub struct PostReference {
    pub uri: String,
    pub cid: String,
}

#[derive(Debug, Clone)]
pub struct CreatePostRequest {
    pub text: String,
    pub reply_to: Option<PostReference>,
}

impl CreatePostRequest {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            reply_to: None,
        }
    }

    pub fn with_reply(mut self, uri: String, cid: String) -> Self {
        self.reply_to = Some(PostReference { uri, cid });
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationReason {
    Mention,
    Reply,
    Follow,
    Like,
    Repost,
    Quote,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlueSkyNotification {
    pub uri: String,
    pub cid: String,
    pub author: BlueSkyProfile,
    pub reason: NotificationReason,
    #[serde(rename = "reasonSubject", skip_serializing_if = "Option::is_none")]
    pub reason_subject: Option<String>,
    pub record: serde_json::Value,
    #[serde(rename = "isRead")]
    pub is_read: bool,
    #[serde(rename = "indexedAt")]
    pub indexed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlueSkyMessage {
    pub id: String,
    pub rev: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub sender: MessageSender,
    #[serde(rename = "sentAt")]
    pub sent_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageSender {
    pub did: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlueSkyConversation {
    pub id: String,
    pub rev: String,
    #[serde(rename = "unreadCount")]
    pub unread_count: u32,
    pub muted: bool,
}

#[derive(Debug, Clone)]
pub struct SendMessageRequest {
    pub convo_id: String,
    pub text: String,
}

impl SendMessageRequest {
    pub fn new(convo_id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            convo_id: convo_id.into(),
            text: text.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlueSkySession {
    pub did: String,
    pub handle: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(rename = "accessJwt")]
    pub access_jwt: String,
    #[serde(rename = "refreshJwt")]
    pub refresh_jwt: String,
}
