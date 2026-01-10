//! RSS Plugin Type Definitions
//!
//! Types for RSS/Atom feed parsing and subscription management.

use serde::{Deserialize, Serialize};

// ============================================================================
// Enums
// ============================================================================

/// Output format for feed items.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FeedFormat {
    /// CSV format (compact, token-efficient)
    #[default]
    Csv,
    /// Markdown format (human-readable)
    Markdown,
}

// ============================================================================
// RSS Feed Types
// ============================================================================

/// RSS channel image metadata.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RssImage {
    /// URL of the image.
    pub url: String,
    /// Image title.
    pub title: String,
    /// Link associated with the image.
    pub link: String,
    /// Image width.
    pub width: String,
    /// Image height.
    pub height: String,
}

/// RSS item enclosure (media attachment).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RssEnclosure {
    /// URL of the enclosed media.
    pub url: String,
    /// MIME type of the media.
    #[serde(rename = "type")]
    pub media_type: String,
    /// Size in bytes.
    pub length: String,
}

/// RSS feed item (article/post).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RssItem {
    /// Item title.
    pub title: String,
    /// Item URL.
    pub link: String,
    /// Publication date.
    #[serde(rename = "pubDate")]
    pub pub_date: String,
    /// Item description/summary.
    pub description: String,
    /// Item author.
    pub author: String,
    /// Categories/tags.
    pub category: Vec<String>,
    /// URL to comments.
    pub comments: String,
    /// Unique identifier.
    pub guid: String,
    /// Media attachment.
    pub enclosure: Option<RssEnclosure>,
}

/// RSS channel (feed) metadata.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RssChannel {
    /// Channel title.
    pub title: String,
    /// Channel description.
    pub description: String,
    /// Channel URL.
    pub link: String,
    /// Channel language (ISO-639).
    pub language: String,
    /// Copyright notice.
    pub copyright: String,
    /// Last build date.
    #[serde(rename = "lastBuildDate")]
    pub last_build_date: String,
    /// Generator software.
    pub generator: String,
    /// RSS specification URL.
    pub docs: String,
    /// Time to live in minutes.
    pub ttl: String,
    /// Channel image.
    pub image: Option<RssImage>,
}

/// Complete RSS feed (channel + items).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RssFeed {
    /// Channel metadata.
    #[serde(flatten)]
    pub channel: RssChannel,
    /// Feed items.
    pub items: Vec<RssItem>,
}

impl RssFeed {
    /// Get the feed title.
    pub fn title(&self) -> &str {
        &self.channel.title
    }

    /// Get the feed link.
    pub fn link(&self) -> &str {
        &self.channel.link
    }

    /// Get the feed description.
    pub fn description(&self) -> &str {
        &self.channel.description
    }
}

// ============================================================================
// Memory Types
// ============================================================================

/// Metadata stored with feed items in memory.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FeedItemMetadata {
    /// Item title.
    pub title: Option<String>,
    /// Item description.
    pub description: Option<String>,
    /// Publication date.
    #[serde(rename = "pubDate")]
    pub pub_date: Option<String>,
    /// Item author.
    pub author: Option<String>,
    /// Feed URL this item came from.
    #[serde(rename = "feedUrl")]
    pub feed_url: Option<String>,
    /// Feed title.
    #[serde(rename = "feedTitle")]
    pub feed_title: Option<String>,
    /// Item link.
    pub link: Option<String>,
    /// Categories.
    pub category: Option<Vec<String>>,
    /// Type marker.
    #[serde(rename = "type")]
    pub item_type: String,
}

impl FeedItemMetadata {
    /// Create new feed item metadata.
    pub fn new() -> Self {
        Self {
            item_type: "feed_item".to_string(),
            ..Default::default()
        }
    }

    /// Create from an RSS item.
    pub fn from_item(item: &RssItem, feed_url: &str, feed_title: &str) -> Self {
        Self {
            title: Some(item.title.clone()),
            description: Some(item.description.clone()),
            pub_date: Some(item.pub_date.clone()),
            author: Some(item.author.clone()),
            feed_url: Some(feed_url.to_string()),
            feed_title: Some(feed_title.to_string()),
            link: Some(item.link.clone()),
            category: Some(item.category.clone()),
            item_type: "feed_item".to_string(),
        }
    }
}

/// Metadata stored with feed subscriptions in memory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedSubscriptionMetadata {
    /// Type marker.
    #[serde(rename = "type")]
    pub sub_type: String,
    /// Subscription timestamp (ms).
    #[serde(rename = "subscribedAt")]
    pub subscribed_at: i64,
    /// Last check timestamp (ms).
    #[serde(rename = "lastChecked")]
    pub last_checked: i64,
    /// Item count at last check.
    #[serde(rename = "lastItemCount")]
    pub last_item_count: usize,
}

impl Default for FeedSubscriptionMetadata {
    fn default() -> Self {
        Self {
            sub_type: "feed_subscription".to_string(),
            subscribed_at: 0,
            last_checked: 0,
            last_item_count: 0,
        }
    }
}

impl FeedSubscriptionMetadata {
    /// Create new subscription metadata.
    pub fn new() -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self {
            sub_type: "feed_subscription".to_string(),
            subscribed_at: now,
            last_checked: 0,
            last_item_count: 0,
        }
    }
}

// ============================================================================
// Configuration
// ============================================================================

/// RSS plugin configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RssConfig {
    /// List of feed URLs to auto-subscribe.
    pub feeds: Vec<String>,
    /// Disable subscription management actions.
    pub disable_actions: bool,
    /// Output format for feed items.
    pub feed_format: FeedFormat,
    /// Interval between feed checks in minutes.
    pub check_interval_minutes: u32,
    /// Request timeout in seconds.
    pub timeout_secs: u64,
    /// User agent for HTTP requests.
    pub user_agent: String,
}

impl Default for RssConfig {
    fn default() -> Self {
        Self {
            feeds: Vec::new(),
            disable_actions: false,
            feed_format: FeedFormat::Csv,
            check_interval_minutes: 15,
            timeout_secs: 30,
            user_agent: "elizaOS-RSS-Plugin/1.0".to_string(),
        }
    }
}

impl RssConfig {
    /// Create a new configuration.
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the initial feeds.
    pub fn feeds(mut self, feeds: Vec<String>) -> Self {
        self.feeds = feeds;
        self
    }

    /// Set the feed format.
    pub fn feed_format(mut self, format: FeedFormat) -> Self {
        self.feed_format = format;
        self
    }

    /// Set the check interval.
    pub fn check_interval(mut self, minutes: u32) -> Self {
        self.check_interval_minutes = minutes;
        self
    }

    /// Set the timeout.
    pub fn timeout(mut self, secs: u64) -> Self {
        self.timeout_secs = secs;
        self
    }
}

