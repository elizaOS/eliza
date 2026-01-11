#![allow(missing_docs)]
//! Core types for the Farcaster plugin.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// ============================================================================
// Enums
// ============================================================================

/// Types of embeds that can be attached to a cast.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EmbedType {
    /// Image embed
    Image,
    /// Video embed
    Video,
    /// Audio embed
    Audio,
    /// URL embed
    Url,
    /// Quoted cast embed
    Cast,
    /// Frame embed
    Frame,
    /// Unknown embed type
    Unknown,
}


impl Default for EmbedType {
    fn default() -> Self {
        Self::Unknown
    }
}

/// Types of Farcaster messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FarcasterMessageType {
    /// A top-level cast
    #[serde(rename = "CAST")]
    Cast,
    /// A reply to another cast
    #[serde(rename = "REPLY")]
    Reply,
}


impl Default for FarcasterMessageType {
    fn default() -> Self {
        Self::Cast
    }
}

/// Farcaster-specific event types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FarcasterEventType {
    /// A cast was generated
    #[serde(rename = "FARCASTER_CAST_GENERATED")]
    CastGenerated,
    /// A mention was received
    #[serde(rename = "FARCASTER_MENTION_RECEIVED")]
    MentionReceived,
    /// A thread cast was created
    #[serde(rename = "FARCASTER_THREAD_CAST_CREATED")]
    ThreadCastCreated,
}

// ============================================================================
// Profile Types
// ============================================================================

/// Farcaster user profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    /// Farcaster ID
    pub fid: u64,
    /// Display name
    pub name: String,
    /// Username (handle)
    pub username: String,
    /// Profile picture URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pfp: Option<String>,
    /// Bio text
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    /// Profile URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl Profile {
    /// Create a new profile with minimal information.
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

// ============================================================================
// Cast Types
// ============================================================================

/// Metadata for embedded content.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EmbedMetadata {
    /// Content type
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    /// Width in pixels
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// Height in pixels
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Duration in seconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<u32>,
    /// Title
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Author FID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_fid: Option<u64>,
    /// Author username
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_username: Option<String>,
}

/// Embed attached to a cast.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CastEmbed {
    /// Type of embed
    #[serde(rename = "type")]
    pub embed_type: EmbedType,
    /// URL of the embedded content
    pub url: String,
    /// For embedded casts, the cast hash
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cast_hash: Option<String>,
    /// Metadata about the embed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<EmbedMetadata>,
}

/// Parent cast reference for replies.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CastParent {
    /// Parent cast hash
    pub hash: String,
    /// Parent author FID
    pub fid: u64,
}

/// Engagement statistics for a cast.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CastStats {
    /// Number of recasts
    pub recasts: u32,
    /// Number of replies
    pub replies: u32,
    /// Number of likes
    pub likes: u32,
}

/// A Farcaster cast (post).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cast {
    /// Cast hash (unique identifier)
    pub hash: String,
    /// Author's Farcaster ID
    pub author_fid: u64,
    /// Cast text content
    pub text: String,
    /// Author's profile
    pub profile: Profile,
    /// Cast timestamp
    pub timestamp: DateTime<Utc>,
    /// Thread ID for conversation tracking
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// Parent cast if this is a reply
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<CastParent>,
    /// Engagement stats
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<CastStats>,
    /// Processed embeds attached to the cast
    #[serde(default)]
    pub embeds: Vec<CastEmbed>,
}

impl Cast {
    /// Check if this cast is a reply.
    pub fn is_reply(&self) -> bool {
        self.in_reply_to.is_some()
    }

    /// Get the message type.
    pub fn message_type(&self) -> FarcasterMessageType {
        if self.is_reply() {
            FarcasterMessageType::Reply
        } else {
            FarcasterMessageType::Cast
        }
    }
}

/// Cast identifier.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CastId {
    /// Cast hash
    pub hash: String,
    /// Author FID
    pub fid: u64,
}

impl CastId {
    /// Create a new cast ID.
    pub fn new(hash: impl Into<String>, fid: u64) -> Self {
        Self {
            hash: hash.into(),
            fid,
        }
    }
}

/// Request parameters for fetching casts by FID.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FidRequest {
    /// Farcaster ID
    pub fid: u64,
    /// Page size
    pub page_size: u32,
}

impl FidRequest {
    /// Create a new FID request.
    pub fn new(fid: u64, page_size: u32) -> Self {
        Self { fid, page_size }
    }
}

/// Last cast information for caching.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastCast {
    /// Cast hash
    pub hash: String,
    /// Timestamp in milliseconds
    pub timestamp: i64,
}

// ============================================================================
// Request/Response Types
// ============================================================================

/// Parameters for sending a cast.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendCastParams {
    /// Cast text
    pub text: String,
    /// Parent cast to reply to
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<CastId>,
}

impl SendCastParams {
    /// Create new send cast params.
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            in_reply_to: None,
        }
    }

    /// Set the reply target.
    pub fn with_reply_to(mut self, hash: impl Into<String>, fid: u64) -> Self {
        self.in_reply_to = Some(CastId::new(hash, fid));
        self
    }
}

/// Response from sending a cast.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendCastResponse {
    /// Cast hash
    pub hash: String,
    /// Author FID
    pub author_fid: u64,
    /// Cast text
    pub text: String,
    /// Timestamp
    pub timestamp: DateTime<Utc>,
    /// Success status
    pub success: bool,
}

/// Response from getting mentions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetMentionsResponse {
    /// List of mention casts
    pub mentions: Vec<Cast>,
    /// Count of mentions
    pub count: usize,
}

/// Response from getting timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetTimelineResponse {
    /// List of timeline casts
    pub timeline: Vec<Cast>,
    /// Cursor for pagination
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Count of casts
    pub count: usize,
}

// ============================================================================
// Internal API Types (for Neynar API responses)
// These types are scaffolding for future Neynar API integration.
// ============================================================================

/// Neynar publish cast request.
#[allow(dead_code)]
#[derive(Debug, Serialize)]
pub(crate) struct PublishCastRequest {
    pub signer_uuid: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
}

/// Neynar publish cast response.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub(crate) struct PublishCastResponse {
    pub cast: PublishCastData,
}

/// Cast data from publish response.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub(crate) struct PublishCastData {
    pub hash: String,
}

/// Neynar get cast response.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub(crate) struct GetCastResponse {
    pub cast: serde_json::Value,
}

/// Neynar bulk users response.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub(crate) struct BulkUsersResponse {
    pub users: Vec<serde_json::Value>,
}

/// Neynar notifications response.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub(crate) struct NotificationsResponse {
    pub notifications: Vec<serde_json::Value>,
}

/// Neynar feed response.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub(crate) struct FeedResponse {
    pub casts: Vec<serde_json::Value>,
    pub next: Option<FeedNextCursor>,
}

/// Next cursor for feed pagination.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub(crate) struct FeedNextCursor {
    pub cursor: Option<String>,
}

// ============================================================================
// Webhook Types
// ============================================================================

/// Author information in webhook data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookAuthor {
    /// Author FID
    pub fid: u64,
    /// Author username
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

/// Cast data from webhook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookCastData {
    /// Cast hash
    pub hash: String,
    /// Cast text
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Author
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<WebhookAuthor>,
    /// Mentioned profiles
    #[serde(default)]
    pub mentioned_profiles: Vec<WebhookAuthor>,
    /// Parent hash
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_hash: Option<String>,
    /// Parent author
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_author: Option<WebhookAuthor>,
}

/// Neynar webhook data structure for cast events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NeynarWebhookData {
    /// Event type
    #[serde(rename = "type")]
    pub event_type: String,
    /// Cast data
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
