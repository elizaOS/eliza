#![allow(missing_docs)]
//! Type definitions for xAI and Twitter API v2.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Twitter API authentication mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    /// OAuth 1.0a with API keys and tokens
    #[default]
    Env,
    /// OAuth 2.0 PKCE flow
    OAuth,
    /// Bearer token authentication
    Bearer,
}

/// Twitter API configuration for X platform.
#[derive(Debug, Clone)]
pub struct TwitterConfig {
    /// Authentication mode
    pub auth_mode: AuthMode,
    /// API key (consumer key)
    pub api_key: String,
    /// API secret (consumer secret)
    pub api_secret: String,
    /// Access token
    pub access_token: String,
    /// Access token secret
    pub access_token_secret: String,
    /// Bearer token for app-only auth
    pub bearer_token: Option<String>,
    /// OAuth 2.0 client ID
    pub client_id: Option<String>,
    /// OAuth 2.0 redirect URI
    pub redirect_uri: Option<String>,
    /// Dry run mode (simulate actions)
    pub dry_run: bool,
    /// Request timeout in seconds
    pub timeout_secs: u64,
}

impl TwitterConfig {
    /// Create a new configuration.
    pub fn new(
        api_key: &str,
        api_secret: &str,
        access_token: &str,
        access_token_secret: &str,
    ) -> Self {
        Self {
            auth_mode: AuthMode::Env,
            api_key: api_key.to_string(),
            api_secret: api_secret.to_string(),
            access_token: access_token.to_string(),
            access_token_secret: access_token_secret.to_string(),
            bearer_token: None,
            client_id: None,
            redirect_uri: None,
            dry_run: false,
            timeout_secs: 30,
        }
    }

    /// Create configuration from environment variables.
    pub fn from_env() -> anyhow::Result<Self> {
        let api_key =
            std::env::var("X_API_KEY").map_err(|_| anyhow::anyhow!("X_API_KEY is required"))?;
        let api_secret = std::env::var("X_API_SECRET")
            .map_err(|_| anyhow::anyhow!("X_API_SECRET is required"))?;
        let access_token = std::env::var("X_ACCESS_TOKEN")
            .map_err(|_| anyhow::anyhow!("X_ACCESS_TOKEN is required"))?;
        let access_token_secret = std::env::var("X_ACCESS_TOKEN_SECRET")
            .map_err(|_| anyhow::anyhow!("X_ACCESS_TOKEN_SECRET is required"))?;

        let mut config = Self::new(&api_key, &api_secret, &access_token, &access_token_secret);

        if let Ok(bearer) = std::env::var("X_BEARER_TOKEN") {
            config.bearer_token = Some(bearer);
        }

        if let Ok(dry_run) = std::env::var("X_DRY_RUN") {
            config.dry_run = dry_run.to_lowercase() == "true";
        }

        Ok(config)
    }

    /// Set bearer token.
    pub fn bearer_token(mut self, token: &str) -> Self {
        self.bearer_token = Some(token.to_string());
        self
    }

    /// Set dry run mode.
    pub fn dry_run(mut self, enabled: bool) -> Self {
        self.dry_run = enabled;
        self
    }
}

/// User profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    /// User ID
    pub id: String,
    /// Username (handle without @)
    pub username: String,
    /// Display name
    pub name: String,
    /// Bio/description
    pub description: Option<String>,
    /// Location
    pub location: Option<String>,
    /// Website URL
    pub url: Option<String>,
    /// Profile image URL
    pub profile_image_url: Option<String>,
    /// Verified status
    pub verified: bool,
    /// Protected/private account
    pub protected: bool,
    /// Follower count
    pub followers_count: u64,
    /// Following count
    pub following_count: u64,
    /// Post count
    pub post_count: u64,
    /// Listed count
    pub listed_count: u64,
    /// Account creation date
    pub created_at: Option<DateTime<Utc>>,
}

/// Post metrics.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PostMetrics {
    /// Like count
    pub like_count: u64,
    /// Repost count
    pub repost_count: u64,
    /// Reply count
    pub reply_count: u64,
    /// Quote count
    pub quote_count: u64,
    /// Impression count
    pub impression_count: u64,
    /// Bookmark count
    pub bookmark_count: u64,
}

/// Photo attachment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Photo {
    /// Media key
    pub id: String,
    /// Image URL
    pub url: String,
    /// Alt text
    pub alt_text: Option<String>,
}

/// Video attachment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Video {
    /// Media key
    pub id: String,
    /// Preview image URL
    pub preview: String,
    /// Video URL
    pub url: Option<String>,
    /// Duration in milliseconds
    pub duration_ms: Option<u64>,
}

/// User mention.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mention {
    /// User ID
    pub id: String,
    /// Username
    pub username: Option<String>,
    /// Display name
    pub name: Option<String>,
}

/// Poll option.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollOption {
    /// Position (0-indexed)
    pub position: Option<u32>,
    /// Option label
    pub label: String,
    /// Vote count
    pub votes: Option<u64>,
}

/// Poll data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollData {
    /// Poll ID
    pub id: Option<String>,
    /// End datetime
    pub end_datetime: Option<DateTime<Utc>>,
    /// Voting status
    pub voting_status: Option<String>,
    /// Duration in minutes
    pub duration_minutes: u32,
    /// Poll options
    pub options: Vec<PollOption>,
}

/// Place/location data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaceData {
    /// Place ID
    pub id: Option<String>,
    /// Place name
    pub name: Option<String>,
    /// Full name
    pub full_name: Option<String>,
    /// Country
    pub country: Option<String>,
    /// Country code
    pub country_code: Option<String>,
    /// Place type
    pub place_type: Option<String>,
}

/// Post.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Post {
    /// Post ID
    pub id: String,
    /// Post text
    pub text: String,
    /// Author ID
    pub author_id: Option<String>,
    /// Conversation ID
    pub conversation_id: Option<String>,
    /// Created at timestamp
    pub created_at: Option<DateTime<Utc>>,
    /// Language
    pub language: Option<String>,
    /// Author username (from includes)
    pub username: String,
    /// Author display name (from includes)
    pub name: String,
    /// Public metrics
    pub metrics: PostMetrics,
    /// Hashtags
    pub hashtags: Vec<String>,
    /// Mentions
    pub mentions: Vec<Mention>,
    /// URLs
    pub urls: Vec<String>,
    /// Photo attachments
    pub photos: Vec<Photo>,
    /// Video attachments
    pub videos: Vec<Video>,
    /// Poll (if any)
    pub poll: Option<PollData>,
    /// Place/location
    pub place: Option<PlaceData>,
    /// In reply to post ID
    pub in_reply_to_id: Option<String>,
    /// Quoted post ID
    pub quoted_id: Option<String>,
    /// Reposted post ID
    pub reposted_id: Option<String>,
    /// Is this a reply?
    pub is_reply: bool,
    /// Is this a repost?
    pub is_repost: bool,
    /// Is this a quote?
    pub is_quote: bool,
    /// Contains sensitive content?
    pub is_sensitive: bool,
    /// Permanent URL
    pub permanent_url: String,
    /// Unix timestamp
    pub timestamp: i64,
}

/// Result of creating a post.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostCreateResult {
    /// Post ID
    pub id: String,
    /// Post text
    pub text: String,
}

/// Response from post queries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryPostsResponse {
    /// List of posts
    pub posts: Vec<Post>,
    /// Pagination token for next page
    pub next_token: Option<String>,
}

/// Response from profile queries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryProfilesResponse {
    /// List of profiles
    pub profiles: Vec<Profile>,
    /// Pagination token for next page
    pub next_token: Option<String>,
}
