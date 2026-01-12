from elizaos_plugin_rss.actions.get_feed import GetFeedAction
from elizaos_plugin_rss.actions.list_feeds import ListFeedsAction
from elizaos_plugin_rss.actions.subscribe_feed import SubscribeFeedAction
from elizaos_plugin_rss.actions.unsubscribe_feed import UnsubscribeFeedAction

__all__ = [
    "GetFeedAction",
    "SubscribeFeedAction",
    "UnsubscribeFeedAction",
    "ListFeedsAction",
]


def get_rss_action_names() -> list[str]:
    return [
        "GET_NEWSFEED",
        "SUBSCRIBE_RSS_FEED",
        "UNSUBSCRIBE_RSS_FEED",
        "LIST_RSS_FEEDS",
    ]
