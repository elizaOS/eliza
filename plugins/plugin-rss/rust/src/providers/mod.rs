pub mod feed_items;

pub use feed_items::FeedItemsProvider;

pub fn get_rss_provider_names() -> Vec<&'static str> {
    vec!["FEEDITEMS"]
}
