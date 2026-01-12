"""Pytest configuration for async tests."""

import pytest

pytest_plugins = ["pytest_asyncio"]


@pytest.fixture
def sample_rss_xml() -> str:
    return """<?xml version="1.0"?>
    <rss version="2.0">
        <channel>
            <title>Sample Feed</title>
            <link>https://example.com</link>
            <description>A sample RSS feed for testing</description>
            <language>en-us</language>
            <lastBuildDate>Mon, 01 Jan 2024 00:00:00 GMT</lastBuildDate>
            <item>
                <title>First Article</title>
                <link>https://example.com/article1</link>
                <description>Description of first article</description>
                <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
                <guid>article-1</guid>
                <author>author@example.com</author>
            </item>
            <item>
                <title>Second Article</title>
                <link>https://example.com/article2</link>
                <description>Description of second article</description>
                <pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate>
                <guid>article-2</guid>
            </item>
        </channel>
    </rss>"""


@pytest.fixture
def sample_atom_xml() -> str:
    return """<?xml version="1.0" encoding="utf-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Sample Atom Feed</title>
        <link href="https://example.com"/>
        <link rel="self" href="https://example.com/atom.xml"/>
        <updated>2024-01-02T00:00:00Z</updated>
        <id>urn:uuid:12345678-1234-1234-1234-123456789abc</id>
        <entry>
            <title>Atom Entry One</title>
            <link href="https://example.com/entry1"/>
            <id>urn:uuid:entry-1</id>
            <updated>2024-01-01T00:00:00Z</updated>
            <summary>Summary of first entry</summary>
            <author>
                <name>John Doe</name>
            </author>
        </entry>
    </feed>"""
