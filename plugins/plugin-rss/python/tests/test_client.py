"""Tests for RSS client."""

import pytest

from elizaos_plugin_rss import extract_urls, format_relative_time


class TestUrlExtraction:
    """Tests for URL extraction utility."""

    def test_extract_http_urls(self) -> None:
        """Test extracting HTTP URLs."""
        text = "Check out https://example.com and http://test.com for more."
        urls = extract_urls(text)
        
        assert len(urls) == 2
        assert "https://example.com" in urls
        assert "http://test.com" in urls

    def test_extract_www_urls(self) -> None:
        """Test extracting www. URLs without scheme."""
        text = "Visit www.example.com for details."
        urls = extract_urls(text)
        
        assert len(urls) == 1
        assert "http://www.example.com" in urls

    def test_extract_urls_with_paths(self) -> None:
        """Test extracting URLs with paths."""
        text = "Read https://example.com/blog/post-1?id=123"
        urls = extract_urls(text)
        
        assert len(urls) == 1
        assert "example.com/blog/post-1" in urls[0]

    def test_extract_urls_strips_punctuation(self) -> None:
        """Test that trailing punctuation is stripped."""
        text = "See https://example.com. Also https://test.com!"
        urls = extract_urls(text)
        
        assert len(urls) == 2
        assert all(not u.endswith(".") and not u.endswith("!") for u in urls)

    def test_extract_urls_deduplicates(self) -> None:
        """Test that duplicate URLs are removed."""
        text = "Visit https://example.com and https://example.com again."
        urls = extract_urls(text)
        
        assert len(urls) == 1

    def test_extract_no_urls(self) -> None:
        """Test extraction from text with no URLs."""
        text = "This text has no URLs."
        urls = extract_urls(text)
        
        assert len(urls) == 0


class TestRelativeTime:
    """Tests for relative time formatting."""

    def test_format_just_now(self) -> None:
        """Test formatting very recent time."""
        import time
        now = int(time.time() * 1000)
        
        result = format_relative_time(now - 30000)  # 30 seconds ago
        assert result == "just now"

    def test_format_minutes_ago(self) -> None:
        """Test formatting time in minutes."""
        import time
        now = int(time.time() * 1000)
        
        result = format_relative_time(now - 5 * 60000)  # 5 minutes ago
        assert "5 minute" in result

    def test_format_hours_ago(self) -> None:
        """Test formatting time in hours."""
        import time
        now = int(time.time() * 1000)
        
        result = format_relative_time(now - 3 * 60 * 60000)  # 3 hours ago
        assert "3 hour" in result

    def test_format_days_ago(self) -> None:
        """Test formatting time in days."""
        import time
        now = int(time.time() * 1000)
        
        result = format_relative_time(now - 2 * 24 * 60 * 60000)  # 2 days ago
        assert "2 day" in result


