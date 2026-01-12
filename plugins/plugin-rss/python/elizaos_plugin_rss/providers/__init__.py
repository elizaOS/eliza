from elizaos_plugin_rss.providers.feed_items import FeedItemsProvider

__all__ = [
    "FeedItemsProvider",
]


def get_rss_provider_names() -> list[str]:
    return ["FEEDITEMS"]
