#![allow(missing_docs)]

pub mod client;
pub mod error;
pub mod parser;
pub mod plugin;
pub mod service;
pub mod types;

pub mod actions;
pub mod providers;

pub use actions::get_feed::{Action, ActionExample};
pub use actions::{
    get_rss_action_names, GetFeedAction, ListFeedsAction, SubscribeFeedAction,
    UnsubscribeFeedAction,
};
pub use client::{extract_urls, format_relative_time, RssClient};
pub use error::{Result, RssError};
pub use parser::{create_empty_feed, parse_rss_to_json};
pub use plugin::{create_plugin, get_rss_plugin, RssPlugin};
pub use providers::feed_items::{Provider, ProviderParams, ProviderResult};
pub use providers::{get_rss_provider_names, FeedItemsProvider};
pub use service::RssService;
pub use types::{FeedFormat, RssConfig, RssFeed, RssItem};

pub const PLUGIN_NAME: &str = "rss";
pub const PLUGIN_DESCRIPTION: &str = "RSS/Atom feed monitoring and subscription management";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
