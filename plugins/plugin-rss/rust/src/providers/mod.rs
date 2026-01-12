//! RSS plugin providers module.

pub mod feed_items;

pub use feed_items::FeedItemsProvider;

/// Get all RSS plugin provider names.
pub fn get_rss_provider_names() -> Vec<&'static str> {
    vec!["FEEDITEMS"]
}
