from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_rss.actions.get_feed import ActionExample


@dataclass
class SubscribeFeedAction:
    @property
    def name(self) -> str:
        return "SUBSCRIBE_RSS_FEED"

    @property
    def similes(self) -> list[str]:
        return ["ADD_RSS_FEED", "FOLLOW_RSS_FEED", "SUBSCRIBE_TO_RSS"]

    @property
    def description(self) -> str:
        return "Subscribe to an RSS/Atom feed for automatic monitoring"

    def _is_subscribe_request(self, text: str) -> bool:
        lower = text.lower()
        has_action = any(word in lower for word in ["subscribe", "add", "follow"])
        has_target = any(word in lower for word in ["rss", "feed"])
        return has_action and has_target

    async def validate(self, message_text: str) -> bool:
        return self._is_subscribe_request(message_text)

    async def handler(self, params: dict[str, object]) -> dict[str, object]:
        url = params.get("url")
        if not url or not isinstance(url, str):
            raise ValueError("Missing 'url' parameter")

        return {
            "action": "SUBSCRIBE_RSS_FEED",
            "url": url,
            "status": "pending_subscription",
        }

    @property
    def examples(self) -> list[ActionExample]:
        return [
            ActionExample(
                input="Subscribe to https://example.com/feed.rss",
                output="I'll subscribe to that RSS feed for you",
            ),
            ActionExample(
                input="Add this feed: https://news.ycombinator.com/rss",
                output="Adding the RSS feed",
            ),
        ]
