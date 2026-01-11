"""
elizaOS RSS Plugin - RSS and Atom feed integration for news monitoring.

This package provides RSS/Atom feed fetching, parsing, and subscription management.
"""

from elizaos_plugin_rss.client import (
    RssClient,
    RssClientError,
    extract_urls,
    format_relative_time,
)
from elizaos_plugin_rss.parser import (
    create_empty_feed,
    parse_rss_to_json,
)
from elizaos_plugin_rss.plugin import (
    RssPlugin,
    create_plugin,
    get_rss_plugin,
)
from elizaos_plugin_rss.types import (
    FeedFormat,
    FeedItemMetadata,
    FeedSubscriptionMetadata,
    RssChannel,
    RssConfig,
    RssEnclosure,
    RssFeed,
    RssImage,
    RssItem,
)

__version__ = "1.0.0"

__all__ = [
    # Main plugin
    "RssPlugin",
    "create_plugin",
    "get_rss_plugin",
    # Client
    "RssClient",
    "RssClientError",
    # Parser
    "parse_rss_to_json",
    "create_empty_feed",
    # Types
    "RssConfig",
    "RssFeed",
    "RssChannel",
    "RssItem",
    "RssImage",
    "RssEnclosure",
    "FeedFormat",
    "FeedItemMetadata",
    "FeedSubscriptionMetadata",
    # Utilities
    "extract_urls",
    "format_relative_time",
]


