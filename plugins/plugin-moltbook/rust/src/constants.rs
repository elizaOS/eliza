#![allow(missing_docs)]

/// Service name for registration
pub const MOLTBOOK_SERVICE_NAME: &str = "moltbook";

/// External service URLs
pub mod urls {
    pub const MOLTBOOK: &str = "https://www.moltbook.com/api/v1";
    pub const OPENROUTER: &str = "https://openrouter.ai/api/v1";
}

/// Default autonomy settings
pub mod autonomy_defaults {
    /// Interval between autonomy cycles (30 seconds)
    pub const MIN_INTERVAL_MS: u64 = 30_000;
    /// Maximum interval (90 seconds)
    pub const MAX_INTERVAL_MS: u64 = 90_000;
    /// Maximum tool calls per cycle
    pub const MAX_TOOL_CALLS: u32 = 5;
    /// Default LLM model
    pub const DEFAULT_MODEL: &str = "deepseek/deepseek-chat-v3-0324";
}

/// Content limits
pub mod content_limits {
    /// Default number of posts to browse
    pub const DEFAULT_BROWSE_LIMIT: u32 = 10;
    /// Maximum post content length
    pub const MAX_CONTENT_LENGTH: usize = 10_000;
    /// Maximum title length
    pub const MAX_TITLE_LENGTH: usize = 300;
    /// Maximum comment length
    pub const MAX_COMMENT_LENGTH: usize = 5_000;
}

/// Default submolt (subreddit equivalent)
pub const DEFAULT_SUBMOLT: &str = "iq";
