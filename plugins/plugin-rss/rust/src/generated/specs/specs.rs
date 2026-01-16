//! Auto-generated canonical action/provider/evaluator docs for plugin-rss.
//! DO NOT EDIT - Generated from prompts/specs/**.

pub const CORE_ACTION_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "actions": [
    {
      "name": "GET_NEWSFEED",
      "description": "Download and parse an RSS/Atom feed from a URL",
      "similes": [
        "FETCH_RSS",
        "READ_FEED",
        "DOWNLOAD_FEED"
      ],
      "parameters": []
    },
    {
      "name": "LIST_RSS_FEEDS",
      "description": "List all subscribed RSS/Atom feeds",
      "similes": [
        "SHOW_RSS_FEEDS",
        "GET_RSS_FEEDS",
        "RSS_SUBSCRIPTIONS"
      ],
      "parameters": []
    },
    {
      "name": "SUBSCRIBE_RSS_FEED",
      "description": "Subscribe to an RSS/Atom feed for automatic monitoring",
      "similes": [
        "ADD_RSS_FEED",
        "FOLLOW_RSS_FEED",
        "SUBSCRIBE_TO_RSS"
      ],
      "parameters": []
    },
    {
      "name": "UNSUBSCRIBE_RSS_FEED",
      "description": "Unsubscribe from an RSS/Atom feed",
      "similes": [
        "REMOVE_RSS_FEED",
        "UNFOLLOW_RSS_FEED",
        "DELETE_RSS_FEED"
      ],
      "parameters": []
    }
  ]
}"#;
pub const ALL_ACTION_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "actions": [
    {
      "name": "GET_NEWSFEED",
      "description": "Download and parse an RSS/Atom feed from a URL",
      "similes": [
        "FETCH_RSS",
        "READ_FEED",
        "DOWNLOAD_FEED"
      ],
      "parameters": []
    },
    {
      "name": "LIST_RSS_FEEDS",
      "description": "List all subscribed RSS/Atom feeds",
      "similes": [
        "SHOW_RSS_FEEDS",
        "GET_RSS_FEEDS",
        "RSS_SUBSCRIPTIONS"
      ],
      "parameters": []
    },
    {
      "name": "SUBSCRIBE_RSS_FEED",
      "description": "Subscribe to an RSS/Atom feed for automatic monitoring",
      "similes": [
        "ADD_RSS_FEED",
        "FOLLOW_RSS_FEED",
        "SUBSCRIBE_TO_RSS"
      ],
      "parameters": []
    },
    {
      "name": "UNSUBSCRIBE_RSS_FEED",
      "description": "Unsubscribe from an RSS/Atom feed",
      "similes": [
        "REMOVE_RSS_FEED",
        "UNFOLLOW_RSS_FEED",
        "DELETE_RSS_FEED"
      ],
      "parameters": []
    }
  ]
}"#;
pub const CORE_PROVIDER_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "providers": [
    {
      "name": "FEEDITEMS",
      "description": "Provides recent news and articles from subscribed RSS feeds",
      "dynamic": true
    }
  ]
}"#;
pub const ALL_PROVIDER_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "providers": [
    {
      "name": "FEEDITEMS",
      "description": "Provides recent news and articles from subscribed RSS feeds",
      "dynamic": true
    }
  ]
}"#;
pub const CORE_EVALUATOR_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "evaluators": []
}"#;
pub const ALL_EVALUATOR_DOCS_JSON: &str = r#"{
  "version": "1.0.0",
  "evaluators": []
}"#;
