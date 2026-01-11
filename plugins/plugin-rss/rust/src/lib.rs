#![allow(missing_docs)]
//! elizaOS RSS Plugin
//!
//! RSS and Atom feed integration for news monitoring.
//!
//! # Example
//!
//! ```rust,no_run
//! use elizaos_plugin_rss::{RssClient, RssConfig};
//!
//! # async fn example() -> anyhow::Result<()> {
//! // Create a client
//! let config = RssConfig::default();
//! let client = RssClient::new(config)?;
//!
//! // Fetch a feed
//! let feed = client.fetch_feed("https://news.ycombinator.com/rss").await?;
//! println!("Feed: {}", feed.title());
//! for item in &feed.items {
//!     println!("  - {}", item.title);
//! }
//! # Ok(())
//! # }
//! ```

#![warn(missing_docs)]

pub mod client;
pub mod error;
pub mod parser;
pub mod plugin;
pub mod types;

// Import directly from submodules:
// - client::{extract_urls, format_relative_time, RssClient}
// - error::{Result, RssError}
// - parser::{create_empty_feed, parse_rss_to_json}
// - plugin::{create_plugin, get_rss_plugin, RssPlugin}
// - types::{FeedFormat, RssFeed, RssItem, etc.}







