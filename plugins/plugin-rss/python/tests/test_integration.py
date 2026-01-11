"""Integration tests for RSS client - real network requests."""

import pytest

from elizaos_plugin_rss import RssClient, RssConfig


@pytest.mark.asyncio
async def test_fetch_real_rss_feed() -> None:
    """Test fetching a real RSS feed."""
    config = RssConfig()
    async with RssClient(config) as client:
        feed = await client.fetch_feed("https://hnrss.org/frontpage")
        
        assert feed.title
        assert len(feed.items) > 0
        
        print(f"✅ Fetched '{feed.title}' with {len(feed.items)} items")
        print(f"   First item: {feed.items[0].title if feed.items else 'N/A'}")


@pytest.mark.asyncio
async def test_fetch_github_blog() -> None:
    """Test fetching GitHub blog feed."""
    config = RssConfig()
    async with RssClient(config) as client:
        feed = await client.fetch_feed("https://github.blog/feed/")
        
        # Just verify we got content (may be RSS or Atom)
        assert feed is not None
        
        print(f"✅ Fetched GitHub blog with {len(feed.items)} items")


@pytest.mark.asyncio
async def test_validate_feed() -> None:
    """Test feed validation."""
    config = RssConfig()
    async with RssClient(config) as client:
        is_valid, message = await client.validate_feed("https://hnrss.org/frontpage")
        
        assert is_valid
        assert "Hacker News" in message
        
        print(f"✅ Validation passed: {message}")


