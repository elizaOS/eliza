use elizaos_plugin_rss::{
    create_empty_feed, create_plugin, extract_urls, format_relative_time, parse_rss_to_json,
    RssConfig,
};

#[test]
fn test_parse_basic_rss() {
    let xml = r#"<?xml version="1.0"?>
        <rss version="2.0">
            <channel>
                <title>Test Feed</title>
                <link>https://example.com</link>
                <description>A test RSS feed</description>
                <item>
                    <title>Test Article</title>
                    <link>https://example.com/article1</link>
                    <description>This is a test article</description>
                    <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
                    <guid>article-1</guid>
                </item>
            </channel>
        </rss>"#;

    let feed = parse_rss_to_json(xml).expect("Failed to parse RSS");

    assert_eq!(feed.title(), "Test Feed");
    assert_eq!(feed.link(), "https://example.com");
    assert_eq!(feed.description(), "A test RSS feed");
    assert_eq!(feed.items.len(), 1);

    let item = &feed.items[0];
    assert_eq!(item.title, "Test Article");
    assert_eq!(item.link, "https://example.com/article1");
    assert_eq!(item.guid, "article-1");
}

#[test]
fn test_parse_rss_with_multiple_items() {
    let xml = r#"<?xml version="1.0"?>
        <rss version="2.0">
            <channel>
                <title>Multi Item Feed</title>
                <item><title>Item 1</title></item>
                <item><title>Item 2</title></item>
                <item><title>Item 3</title></item>
            </channel>
        </rss>"#;

    let feed = parse_rss_to_json(xml).expect("Failed to parse RSS");
    assert_eq!(feed.items.len(), 3);
}

#[test]
fn test_parse_rss_with_enclosure() {
    let xml = r#"<?xml version="1.0"?>
        <rss version="2.0">
            <channel>
                <title>Podcast Feed</title>
                <item>
                    <title>Episode 1</title>
                    <enclosure url="https://example.com/ep1.mp3" type="audio/mpeg" length="12345678"/>
                </item>
            </channel>
        </rss>"#;

    let feed = parse_rss_to_json(xml).expect("Failed to parse RSS");
    assert_eq!(feed.items.len(), 1);

    let enclosure = feed.items[0].enclosure.as_ref().expect("Missing enclosure");
    assert_eq!(enclosure.url, "https://example.com/ep1.mp3");
    assert_eq!(enclosure.media_type, "audio/mpeg");
}

#[test]
fn test_parse_atom_feed() {
    let xml = r#"<?xml version="1.0" encoding="utf-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
            <title>Atom Test Feed</title>
            <link href="https://example.com"/>
            <subtitle>A test Atom feed</subtitle>
            <entry>
                <title>Atom Entry</title>
                <link href="https://example.com/entry1"/>
                <id>entry-1</id>
                <published>2024-01-01T00:00:00Z</published>
                <summary>This is an Atom entry</summary>
            </entry>
        </feed>"#;

    let feed = parse_rss_to_json(xml).expect("Failed to parse Atom");

    assert_eq!(feed.title(), "Atom Test Feed");
    assert_eq!(feed.items.len(), 1);
    assert_eq!(feed.items[0].title, "Atom Entry");
    assert_eq!(feed.items[0].guid, "entry-1");
}

#[test]
fn test_create_empty_feed() {
    let feed = create_empty_feed();
    assert!(feed.title().is_empty());
    assert!(feed.items.is_empty());
}

#[test]
fn test_extract_urls() {
    let text = "Check out https://example.com and http://test.com for more.";
    let urls = extract_urls(text);

    assert_eq!(urls.len(), 2);
    assert!(urls.iter().any(|u| u.contains("example.com")));
    assert!(urls.iter().any(|u| u.contains("test.com")));
}

#[test]
fn test_extract_urls_with_www() {
    let text = "Visit www.example.com for details.";
    let urls = extract_urls(text);

    assert_eq!(urls.len(), 1);
    assert!(urls[0].starts_with("http://www.example.com"));
}

#[test]
fn test_extract_urls_deduplicates() {
    let text = "Visit https://example.com and https://example.com again.";
    let urls = extract_urls(text);

    assert_eq!(urls.len(), 1);
}

#[test]
fn test_format_relative_time() {
    let now = chrono::Utc::now().timestamp_millis();

    // Just now
    let result = format_relative_time(now - 30_000);
    assert_eq!(result, "just now");

    // Minutes ago
    let result = format_relative_time(now - 5 * 60_000);
    assert!(result.contains("5 minute"));

    // Hours ago
    let result = format_relative_time(now - 3 * 60 * 60_000);
    assert!(result.contains("3 hour"));

    // Days ago
    let result = format_relative_time(now - 2 * 24 * 60 * 60_000);
    assert!(result.contains("2 day"));
}

#[test]
fn test_config_builder() {
    let config = RssConfig::new()
        .feeds(vec!["https://example.com/feed.rss".to_string()])
        .check_interval(30)
        .timeout(60);

    assert_eq!(config.feeds.len(), 1);
    assert_eq!(config.check_interval_minutes, 30);
    assert_eq!(config.timeout_secs, 60);
}

#[tokio::test]
async fn test_plugin_creation() {
    let plugin = create_plugin(RssConfig::default());
    assert!(plugin.config().feeds.is_empty());
}
