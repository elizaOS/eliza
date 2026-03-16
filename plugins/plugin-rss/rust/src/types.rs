#![allow(missing_docs)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FeedFormat {
    #[default]
    Csv,
    Markdown,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RssImage {
    pub url: String,
    pub title: String,
    pub link: String,
    pub width: String,
    pub height: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RssEnclosure {
    pub url: String,
    #[serde(rename = "type")]
    pub media_type: String,
    pub length: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RssItem {
    pub title: String,
    pub link: String,
    #[serde(rename = "pubDate")]
    pub pub_date: String,
    pub description: String,
    pub author: String,
    pub category: Vec<String>,
    pub comments: String,
    pub guid: String,
    pub enclosure: Option<RssEnclosure>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RssChannel {
    pub title: String,
    pub description: String,
    pub link: String,
    pub language: String,
    pub copyright: String,
    #[serde(rename = "lastBuildDate")]
    pub last_build_date: String,
    pub generator: String,
    pub docs: String,
    pub ttl: String,
    pub image: Option<RssImage>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RssFeed {
    #[serde(flatten)]
    pub channel: RssChannel,
    pub items: Vec<RssItem>,
}

impl RssFeed {
    pub fn title(&self) -> &str {
        &self.channel.title
    }

    pub fn link(&self) -> &str {
        &self.channel.link
    }

    pub fn description(&self) -> &str {
        &self.channel.description
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FeedItemMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "pubDate")]
    pub pub_date: Option<String>,
    pub author: Option<String>,
    #[serde(rename = "feedUrl")]
    pub feed_url: Option<String>,
    #[serde(rename = "feedTitle")]
    pub feed_title: Option<String>,
    pub link: Option<String>,
    pub category: Option<Vec<String>>,
    #[serde(rename = "type")]
    pub item_type: String,
}

impl FeedItemMetadata {
    pub fn new() -> Self {
        Self {
            item_type: "feed_item".to_string(),
            ..Default::default()
        }
    }

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedSubscriptionMetadata {
    #[serde(rename = "type")]
    pub sub_type: String,
    #[serde(rename = "subscribedAt")]
    pub subscribed_at: i64,
    #[serde(rename = "lastChecked")]
    pub last_checked: i64,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RssConfig {
    pub feeds: Vec<String>,
    pub disable_actions: bool,
    pub feed_format: FeedFormat,
    pub check_interval_minutes: u32,
    pub timeout_secs: u64,
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
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feeds(mut self, feeds: Vec<String>) -> Self {
        self.feeds = feeds;
        self
    }

    pub fn feed_format(mut self, format: FeedFormat) -> Self {
        self.feed_format = format;
        self
    }

    pub fn check_interval(mut self, minutes: u32) -> Self {
        self.check_interval_minutes = minutes;
        self
    }

    pub fn timeout(mut self, secs: u64) -> Self {
        self.timeout_secs = secs;
        self
    }
}
