# Actions
from elizaos_plugin_rss.actions import (
    GetFeedAction,
    ListFeedsAction,
    SubscribeFeedAction,
    UnsubscribeFeedAction,
    get_rss_action_names,
)
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
from elizaos_plugin_rss.providers import (
    FeedItemsProvider,
    get_rss_provider_names,
)
from elizaos_plugin_rss.service import RssService
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

# Plugin metadata
PLUGIN_NAME = "rss"
PLUGIN_DESCRIPTION = "RSS/Atom feed monitoring and subscription management"

__all__ = [
    # Main plugin
    "RssPlugin",
    "create_plugin",
    "get_rss_plugin",
    "RssClient",
    "RssClientError",
    # Parser
    "parse_rss_to_json",
    "create_empty_feed",
    "GetFeedAction",
    "SubscribeFeedAction",
    "UnsubscribeFeedAction",
    "ListFeedsAction",
    "get_rss_action_names",
    # Providers
    "FeedItemsProvider",
    "get_rss_provider_names",
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
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
    # Service
    "RssService",
]
