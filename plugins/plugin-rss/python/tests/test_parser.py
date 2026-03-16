import pytest

from elizaos_plugin_rss import create_empty_feed, parse_rss_to_json


class TestRssParser:
    def test_parse_empty_feed(self) -> None:
        feed = create_empty_feed()
        assert feed.title == ""
        assert feed.items == []

    def test_parse_basic_rss(self) -> None:
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
                    <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
                    <guid>article-1</guid>
                </item>
            </channel>
        </rss>"""

        feed = parse_rss_to_json(xml)

        assert feed.title == "Test Feed"
        assert feed.link == "https://example.com"
        assert feed.description == "A test RSS feed"
        assert len(feed.items) == 1

        item = feed.items[0]
        assert item.title == "Test Article"
        assert item.link == "https://example.com/article1"
        assert item.guid == "article-1"

    def test_parse_rss_with_categories(self) -> None:
        xml = """<?xml version="1.0"?>
        <rss version="2.0">
            <channel>
                <title>Test Feed</title>
                <link>https://example.com</link>
                <item>
                    <title>Multi-category Article</title>
                    <category>Tech</category>
                    <category>News</category>
                    <category>AI</category>
                </item>
            </channel>
        </rss>"""

        feed = parse_rss_to_json(xml)

        assert len(feed.items) == 1
        assert feed.items[0].category == ["Tech", "News", "AI"]

    def test_parse_rss_with_enclosure(self) -> None:
        xml = """<?xml version="1.0"?>
        <rss version="2.0">
            <channel>
                <title>Podcast Feed</title>
                <link>https://example.com</link>
                <item>
                    <title>Episode 1</title>
                    <enclosure url="https://example.com/ep1.mp3" type="audio/mpeg" length="12345678"/>
                </item>
            </channel>
        </rss>"""

        feed = parse_rss_to_json(xml)

        assert len(feed.items) == 1
        enclosure = feed.items[0].enclosure
        assert enclosure is not None
        assert enclosure.url == "https://example.com/ep1.mp3"
        assert enclosure.type == "audio/mpeg"

    def test_parse_rss_with_cdata(self) -> None:
        xml = """<?xml version="1.0"?>
        <rss version="2.0">
            <channel>
                <title>Test Feed</title>
                <link>https://example.com</link>
                <item>
                    <title>CDATA Article</title>
                    <description><![CDATA[<p>HTML content here</p>]]></description>
                </item>
            </channel>
        </rss>"""

        feed = parse_rss_to_json(xml)

        assert len(feed.items) == 1
        assert "<p>HTML content here</p>" in feed.items[0].description

    def test_parse_invalid_xml(self) -> None:
        with pytest.raises(ValueError):
            parse_rss_to_json("not valid xml")

    def test_parse_missing_channel(self) -> None:
        xml = """<?xml version="1.0"?>
        <rss version="2.0">
        </rss>"""

        with pytest.raises(ValueError, match="No channel element"):
            parse_rss_to_json(xml)


class TestAtomParser:
    def test_parse_basic_atom(self) -> None:
        xml = """<?xml version="1.0" encoding="utf-8"?>
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
        </feed>"""

        feed = parse_rss_to_json(xml)

        assert feed.title == "Atom Test Feed"
        assert len(feed.items) == 1

        item = feed.items[0]
        assert item.title == "Atom Entry"
        assert item.guid == "entry-1"
