class TestRssPluginStructure:
    def test_import_plugin(self) -> None:
        from elizaos_plugin_rss import RssPlugin

        assert RssPlugin is not None

    def test_import_client(self) -> None:
        from elizaos_plugin_rss import RssClient

        assert RssClient is not None

    def test_import_parser(self) -> None:
        from elizaos_plugin_rss import create_empty_feed, parse_rss_to_json

        assert parse_rss_to_json is not None
        assert create_empty_feed is not None

    def test_import_types(self) -> None:
        from elizaos_plugin_rss import (
            FeedFormat,
            RssConfig,
            RssFeed,
            RssItem,
        )

        assert RssConfig is not None
        assert RssFeed is not None
        assert RssItem is not None
        assert FeedFormat is not None


class TestRssPluginCreation:
    def test_create_plugin(self) -> None:
        from elizaos_plugin_rss import RssPlugin

        plugin = RssPlugin()
        assert plugin is not None

    def test_get_rss_plugin(self) -> None:
        from elizaos_plugin_rss import get_rss_plugin

        plugin = get_rss_plugin()
        assert plugin is not None


class TestRssParser:
    """Tests for RSS parsing."""

    def test_create_empty_feed(self) -> None:
        """Test creating empty feed."""
        from elizaos_plugin_rss import create_empty_feed

        feed = create_empty_feed()
        assert feed.title == ""
        assert feed.items == []

    def test_parse_basic_rss(self) -> None:
        from elizaos_plugin_rss import parse_rss_to_json

        xml = """<?xml version="1.0"?>
        <rss version="2.0">
            <channel>
                <title>Test Feed</title>
                <link>https://example.com</link>
                <description>A test RSS feed</description>
                <item>
                    <title>Test Article</title>
                    <link>https://example.com/article1</link>
                    <description>This is a test article</description>
                </item>
            </channel>
        </rss>"""

        feed = parse_rss_to_json(xml)

        assert feed.title == "Test Feed"
        assert len(feed.items) == 1
        assert feed.items[0].title == "Test Article"

    def test_parse_rss_with_multiple_items(self) -> None:
        from elizaos_plugin_rss import parse_rss_to_json

        xml = """<?xml version="1.0"?>
        <rss version="2.0">
            <channel>
                <title>Multi Item Feed</title>
                <item><title>Item 1</title></item>
                <item><title>Item 2</title></item>
                <item><title>Item 3</title></item>
            </channel>
        </rss>"""

        feed = parse_rss_to_json(xml)
        assert len(feed.items) == 3


class TestRssUtils:
    def test_extract_urls(self) -> None:
        from elizaos_plugin_rss import extract_urls

        text = "Check out https://example.com and http://test.com for more."
        urls = extract_urls(text)

        assert len(urls) == 2
        assert any("example.com" in u for u in urls)

    def test_format_relative_time(self) -> None:
        import time

        from elizaos_plugin_rss import format_relative_time

        now = int(time.time() * 1000)
        result = format_relative_time(now - 30000)  # 30 seconds ago
        assert "just now" in result or "second" in result
