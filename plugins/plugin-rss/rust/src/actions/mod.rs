pub mod get_feed;
pub mod subscribe_feed;
pub mod unsubscribe_feed;
pub mod list_feeds;

pub use get_feed::GetFeedAction;
pub use subscribe_feed::SubscribeFeedAction;
pub use unsubscribe_feed::UnsubscribeFeedAction;
pub use list_feeds::ListFeedsAction;

pub fn get_rss_action_names() -> Vec<&'static str> {
    vec![
        "GET_NEWSFEED",
        "SUBSCRIBE_RSS_FEED",
        "UNSUBSCRIBE_RSS_FEED",
        "LIST_RSS_FEEDS",
    ]
}
