//! Type definitions for the Instagram plugin
//!
//! Strong types with validation - no unknown or any types.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;

/// Instagram event types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InstagramEventType {
    /// Direct message received
    MessageReceived,
    /// Direct message sent
    MessageSent,
    /// Comment received on a post
    CommentReceived,
    /// Like received on a post
    LikeReceived,
    /// New follower
    FollowReceived,
    /// Lost a follower
    UnfollowReceived,
    /// Story was viewed
    StoryViewed,
    /// Reply to story received
    StoryReplyReceived,
}

impl fmt::Display for InstagramEventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::MessageReceived => "INSTAGRAM_MESSAGE_RECEIVED",
            Self::MessageSent => "INSTAGRAM_MESSAGE_SENT",
            Self::CommentReceived => "INSTAGRAM_COMMENT_RECEIVED",
            Self::LikeReceived => "INSTAGRAM_LIKE_RECEIVED",
            Self::FollowReceived => "INSTAGRAM_FOLLOW_RECEIVED",
            Self::UnfollowReceived => "INSTAGRAM_UNFOLLOW_RECEIVED",
            Self::StoryViewed => "INSTAGRAM_STORY_VIEWED",
            Self::StoryReplyReceived => "INSTAGRAM_STORY_REPLY_RECEIVED",
        };
        write!(f, "{}", s)
    }
}

/// Instagram media types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstagramMediaType {
    /// Photo post
    Photo,
    /// Video post
    Video,
    /// Carousel/album post
    Carousel,
    /// Reel
    Reel,
    /// Story
    Story,
    /// IGTV video
    Igtv,
}

impl fmt::Display for InstagramMediaType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::Photo => "photo",
            Self::Video => "video",
            Self::Carousel => "carousel",
            Self::Reel => "reel",
            Self::Story => "story",
            Self::Igtv => "igtv",
        };
        write!(f, "{}", s)
    }
}

/// Instagram user information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstagramUser {
    /// User's primary key/ID
    pub pk: i64,
    /// Username
    pub username: String,
    /// Full display name
    pub full_name: Option<String>,
    /// Profile picture URL
    pub profile_pic_url: Option<String>,
    /// Whether account is private
    pub is_private: bool,
    /// Whether account is verified
    pub is_verified: bool,
    /// Number of followers
    pub follower_count: Option<i64>,
    /// Number of accounts following
    pub following_count: Option<i64>,
}

impl InstagramUser {
    /// Get display name (full name or username)
    pub fn display_name(&self) -> &str {
        self.full_name.as_deref().unwrap_or(&self.username)
    }
}

/// Instagram media information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstagramMedia {
    /// Media's primary key/ID
    pub pk: i64,
    /// Type of media
    pub media_type: InstagramMediaType,
    /// Caption text
    pub caption: Option<String>,
    /// Media URL
    pub url: Option<String>,
    /// Thumbnail URL for videos
    pub thumbnail_url: Option<String>,
    /// Number of likes
    pub like_count: i64,
    /// Number of comments
    pub comment_count: i64,
    /// When media was posted
    pub taken_at: Option<DateTime<Utc>>,
    /// User who posted
    pub user: Option<InstagramUser>,
}

/// Instagram direct message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstagramMessage {
    /// Message ID
    pub id: String,
    /// Thread/conversation ID
    pub thread_id: String,
    /// Message text
    pub text: Option<String>,
    /// When message was sent
    pub timestamp: DateTime<Utc>,
    /// User who sent the message
    pub user: InstagramUser,
    /// Optional attached media
    pub media: Option<InstagramMedia>,
    /// Whether message has been seen
    pub is_seen: bool,
}

/// Instagram comment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstagramComment {
    /// Comment's primary key
    pub pk: i64,
    /// Comment text
    pub text: String,
    /// When comment was posted
    pub created_at: DateTime<Utc>,
    /// User who commented
    pub user: InstagramUser,
    /// Media the comment is on
    pub media_pk: i64,
    /// If replying to another comment
    pub reply_to_pk: Option<i64>,
}

/// Instagram DM thread
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstagramThread {
    /// Thread ID
    pub id: String,
    /// Users in the thread
    pub users: Vec<InstagramUser>,
    /// Last activity timestamp
    pub last_activity_at: Option<DateTime<Utc>>,
    /// Whether this is a group thread
    pub is_group: bool,
    /// Thread title for groups
    pub thread_title: Option<String>,
}

impl InstagramThread {
    /// Get display name for the thread
    pub fn display_name(&self) -> String {
        if let Some(ref title) = self.thread_title {
            return title.clone();
        }

        if self.users.is_empty() {
            return "Unknown Thread".to_string();
        }

        if self.users.len() == 1 {
            return self.users[0].display_name().to_string();
        }

        self.users
            .iter()
            .map(|u| u.username.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// Message payload for events
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstagramMessagePayload {
    /// Event type
    pub event_type: InstagramEventType,
    /// Message data
    pub message: InstagramMessage,
    /// Thread data
    pub thread: InstagramThread,
}

/// Comment payload for events
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstagramCommentPayload {
    /// Event type
    pub event_type: InstagramEventType,
    /// Comment data
    pub comment: InstagramComment,
    /// Media that was commented on
    pub media: InstagramMedia,
}

/// Follow payload for events
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstagramFollowPayload {
    /// Event type
    pub event_type: InstagramEventType,
    /// User who followed/unfollowed
    pub user: InstagramUser,
}

/// Story payload for events
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstagramStoryPayload {
    /// Event type
    pub event_type: InstagramEventType,
    /// Story media
    pub story: InstagramMedia,
    /// User who viewed/replied
    pub user: InstagramUser,
    /// Reply text if applicable
    pub reply_text: Option<String>,
}

/// Action context for Instagram actions
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstagramActionContext {
    /// Original message/event data
    pub message: serde_json::Value,
    /// User ID
    pub user_id: i64,
    /// Thread ID for DMs
    pub thread_id: Option<String>,
    /// Media ID for comments
    pub media_id: Option<i64>,
    /// Current state
    pub state: serde_json::Value,
}

/// Provider context
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstagramProviderContext {
    /// User ID
    pub user_id: Option<i64>,
    /// Thread ID
    pub thread_id: Option<String>,
    /// Media ID
    pub media_id: Option<i64>,
    /// Room/conversation ID
    pub room_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_type_display() {
        assert_eq!(
            InstagramEventType::MessageReceived.to_string(),
            "INSTAGRAM_MESSAGE_RECEIVED"
        );
    }

    #[test]
    fn test_media_type_display() {
        assert_eq!(InstagramMediaType::Photo.to_string(), "photo");
        assert_eq!(InstagramMediaType::Reel.to_string(), "reel");
    }

    #[test]
    fn test_user_display_name() {
        let user = InstagramUser {
            pk: 12345,
            username: "testuser".to_string(),
            full_name: Some("Test User".to_string()),
            profile_pic_url: None,
            is_private: false,
            is_verified: false,
            follower_count: None,
            following_count: None,
        };
        assert_eq!(user.display_name(), "Test User");

        let user_no_name = InstagramUser {
            pk: 12345,
            username: "testuser".to_string(),
            full_name: None,
            profile_pic_url: None,
            is_private: false,
            is_verified: false,
            follower_count: None,
            following_count: None,
        };
        assert_eq!(user_no_name.display_name(), "testuser");
    }

    #[test]
    fn test_thread_display_name() {
        let thread = InstagramThread {
            id: "thread-1".to_string(),
            users: vec![InstagramUser {
                pk: 12345,
                username: "user1".to_string(),
                full_name: None,
                profile_pic_url: None,
                is_private: false,
                is_verified: false,
                follower_count: None,
                following_count: None,
            }],
            last_activity_at: None,
            is_group: false,
            thread_title: None,
        };
        assert_eq!(thread.display_name(), "user1");

        let thread_with_title = InstagramThread {
            id: "thread-2".to_string(),
            users: vec![],
            last_activity_at: None,
            is_group: true,
            thread_title: Some("Group Chat".to_string()),
        };
        assert_eq!(thread_with_title.display_name(), "Group Chat");
    }
}
