#![allow(missing_docs)]

use serde::{Deserialize, Serialize};

/// Configuration for the Moltbook service
#[derive(Debug, Clone)]
pub struct MoltbookConfig {
    /// Agent display name
    pub agent_name: String,
    /// Moltbook API token for social engagement
    pub moltbook_token: Option<String>,
    /// Whether autonomy mode is enabled
    pub autonomous_mode: bool,
    /// Autonomy loop interval in ms
    pub autonomy_interval_ms: Option<u64>,
    /// Maximum autonomy steps before stopping (0 = unlimited)
    pub autonomy_max_steps: Option<u32>,
}

/// Moltbook post author
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoltbookAuthor {
    pub name: String,
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

/// Moltbook submolt reference on a post
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoltbookSubmoltRef {
    pub name: String,
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

/// Moltbook post structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoltbookPost {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submolt: Option<MoltbookSubmoltRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<MoltbookAuthor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upvotes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

/// Moltbook comment structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoltbookComment {
    pub id: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<MoltbookAuthor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

/// Moltbook submolt (subreddit equivalent) structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoltbookSubmolt {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscriber_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
}

/// Event types emitted by the Moltbook service
pub mod event_types {
    pub const POST_CREATED: &str = "moltbook.post.created";
    pub const COMMENT_CREATED: &str = "moltbook.comment.created";
    pub const POSTS_BROWSED: &str = "moltbook.posts.browsed";
    pub const POST_READ: &str = "moltbook.post.read";
    pub const AUTONOMY_STEP_COMPLETED: &str = "moltbook.autonomy.step.completed";
    pub const AUTONOMY_STARTED: &str = "moltbook.autonomy.started";
    pub const AUTONOMY_STOPPED: &str = "moltbook.autonomy.stopped";
}

/// Payload for post events
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoltbookPostPayload {
    pub post_id: String,
    pub submolt: String,
    pub title: String,
}

/// Payload for comment events
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoltbookCommentPayload {
    pub comment_id: String,
    pub post_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

/// Payload for autonomy step events
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoltbookAutonomyStepPayload {
    pub step_number: u32,
    pub action: String,
    pub result: String,
    pub timestamp: String,
}

/// Result type for API operations that can fail.
/// Prevents silent failures by making errors explicit.
#[derive(Debug, Clone)]
pub enum MoltbookResult<T> {
    Success(T),
    Failure(String),
}

impl<T> MoltbookResult<T> {
    /// Check if the result is a success
    pub fn is_success(&self) -> bool {
        matches!(self, MoltbookResult::Success(_))
    }

    /// Get the data if successful, or None
    pub fn data(&self) -> Option<&T> {
        match self {
            MoltbookResult::Success(data) => Some(data),
            MoltbookResult::Failure(_) => None,
        }
    }

    /// Get the error message if failed, or None
    pub fn error(&self) -> Option<&str> {
        match self {
            MoltbookResult::Success(_) => None,
            MoltbookResult::Failure(err) => Some(err),
        }
    }
}

/// Helper to create a successful result
pub fn moltbook_success<T>(data: T) -> MoltbookResult<T> {
    MoltbookResult::Success(data)
}

/// Helper to create a failed result
pub fn moltbook_failure<T>(error: impl Into<String>) -> MoltbookResult<T> {
    MoltbookResult::Failure(error.into())
}

/// Result of reading a post with its comments
#[derive(Debug, Clone)]
pub struct PostWithComments {
    pub post: MoltbookPost,
    pub comments: Vec<MoltbookComment>,
}

/// Action result type
#[derive(Debug, Clone, Serialize)]
pub struct ActionResult {
    pub text: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl ActionResult {
    pub fn success(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            success: true,
            data: None,
        }
    }

    pub fn success_with_data(text: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            text: text.into(),
            success: true,
            data: Some(data),
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            success: false,
            data: None,
        }
    }
}

/// Provider result type
#[derive(Debug, Clone, Serialize)]
pub struct ProviderResult {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl ProviderResult {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            data: None,
        }
    }

    pub fn with_data(text: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            text: text.into(),
            data: Some(data),
        }
    }
}
