"""
RSS Client

Async HTTP client for fetching and parsing RSS/Atom feeds.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

import httpx

from elizaos_plugin_rss.parser import create_empty_feed, parse_rss_to_json
from elizaos_plugin_rss.types import RssConfig, RssFeed

if TYPE_CHECKING:
    pass


class RssClientError(Exception):
    """Base exception for RSS client errors."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class RssClient:
    """
    Async RSS feed client.

    Fetches and parses RSS/Atom feeds using httpx.
    """

    def __init__(self, config: RssConfig | None = None) -> None:
        """
        Initialize the RSS client.

        Args:
            config: Optional RSS configuration.
        """
        self._config = config or RssConfig()
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(self._config.timeout),
            headers={
                "User-Agent": self._config.user_agent,
                "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
            },
            follow_redirects=True,
        )

    async def close(self) -> None:
        """Close the HTTP client."""
        await self._client.aclose()

    async def __aenter__(self) -> "RssClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def fetch_feed(self, url: str) -> RssFeed:
        """
        Fetch and parse an RSS/Atom feed.

        Args:
            url: The feed URL to fetch.

        Returns:
            Parsed RssFeed object.

        Raises:
            RssClientError: If the request fails or feed cannot be parsed.
        """
        try:
            response = await self._client.get(url)
            response.raise_for_status()
            
            content = response.text
            if not content:
                raise RssClientError(f"Empty response from {url}")
            
            try:
                feed = parse_rss_to_json(content)
                return feed
            except ValueError as e:
                raise RssClientError(f"Failed to parse feed: {e}") from e
                
        except httpx.HTTPStatusError as e:
            raise RssClientError(
                f"HTTP error fetching {url}: {e.response.status_code}",
                status_code=e.response.status_code,
            ) from e
        except httpx.RequestError as e:
            raise RssClientError(f"Request error fetching {url}: {e}") from e

    async def fetch_feed_safe(self, url: str) -> RssFeed | None:
        """
        Fetch and parse a feed, returning None on error.

        Args:
            url: The feed URL to fetch.

        Returns:
            Parsed RssFeed object or None on error.
        """
        try:
            return await self.fetch_feed(url)
        except RssClientError:
            return None

    async def validate_feed(self, url: str) -> tuple[bool, str]:
        """
        Validate that a URL points to a valid RSS/Atom feed.

        Args:
            url: The URL to validate.

        Returns:
            Tuple of (is_valid, message).
        """
        try:
            feed = await self.fetch_feed(url)
            if feed.title:
                return True, f"Valid feed: {feed.title}"
            return True, "Valid feed (no title)"
        except RssClientError as e:
            return False, str(e)


def extract_urls(text: str) -> list[str]:
    """
    Extract all URLs from a block of text.

    - Supports http(s)://, ftp://, and schemeless "www." links
    - Strips trailing punctuation
    - Normalizes and deduplicates results

    Args:
        text: The text to extract URLs from.

    Returns:
        List of normalized URL strings.
    """
    url_pattern = re.compile(r'(?:(?:https?|ftp)://|www\.)[^\s<>"\'`]+', re.IGNORECASE)
    candidates = url_pattern.findall(text)

    results: list[str] = []
    seen: set[str] = set()

    trailing_punct = re.compile(r'[)\]}>,.;!?:\'"\u2026]$')

    for raw in candidates:
        # Trim leading wrappers
        candidate = re.sub(r'^[(\[{<\'"]+', '', raw)

        # Add scheme if missing
        with_scheme = f"http://{candidate}" if candidate.startswith("www.") else candidate

        # Always strip common trailing punctuation first
        while with_scheme and trailing_punct.search(with_scheme):
            with_scheme = with_scheme[:-1]

        if not with_scheme or not _is_valid_url(with_scheme):
            continue

        # Normalize
        try:
            from urllib.parse import urlparse, urlunparse
            parsed = urlparse(with_scheme)
            normalized = urlunparse(parsed)
            if normalized not in seen:
                seen.add(normalized)
                results.append(normalized)
        except Exception:  # noqa: S110
            continue

    return results


def _is_valid_url(url: str) -> bool:
    """Check if a string is a valid URL."""
    try:
        from urllib.parse import urlparse
        result = urlparse(url)
        return all([result.scheme, result.netloc])
    except Exception:  # noqa: S110
        return False


def format_relative_time(timestamp_ms: int) -> str:
    """
    Format a relative time string (e.g., "5 minutes ago").

    Args:
        timestamp_ms: Timestamp in milliseconds.

    Returns:
        Human-readable relative time string.
    """
    import time
    
    now_ms = int(time.time() * 1000)
    time_since = now_ms - timestamp_ms
    minutes_since = time_since // 60000
    hours_since = minutes_since // 60
    days_since = hours_since // 24

    if days_since > 0:
        return f"{days_since} day{'s' if days_since > 1 else ''} ago"
    elif hours_since > 0:
        return f"{hours_since} hour{'s' if hours_since > 1 else ''} ago"
    elif minutes_since > 0:
        return f"{minutes_since} minute{'s' if minutes_since > 1 else ''} ago"
    else:
        return "just now"

