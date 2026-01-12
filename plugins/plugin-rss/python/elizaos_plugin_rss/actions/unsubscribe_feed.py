from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_rss.actions.get_feed import ActionExample


@dataclass
class UnsubscribeFeedAction:
    @property
    def name(self) -> str:
        return "UNSUBSCRIBE_RSS_FEED"

    @property
    def similes(self) -> list[str]:
        return ["REMOVE_RSS_FEED", "DELETE_RSS_FEED", "STOP_RSS_FEED"]

    @property
    def description(self) -> str:
        return "Unsubscribe from an RSS/Atom feed"

    def _is_unsubscribe_request(self, text: str) -> bool:
        lower = text.lower()
        has_action = any(word in lower for word in ["unsubscribe", "remove", "delete", "stop"])
        has_target = any(word in lower for word in ["rss", "feed"])
        return has_action and has_target

    async def validate(self, message_text: str) -> bool:
        return self._is_unsubscribe_request(message_text)

    async def handler(self, params: dict[str, object]) -> dict[str, object]:
        url = params.get("url")
        if not url or not isinstance(url, str):
            raise ValueError("Missing 'url' parameter")

        return {
            "action": "UNSUBSCRIBE_RSS_FEED",
            "url": url,
            "status": "pending_unsubscription",
        }

    @property
    def examples(self) -> list[ActionExample]:
        return [
            ActionExample(
                input="Unsubscribe from https://example.com/feed.rss",
                output="I'll unsubscribe you from that feed",
            ),
            ActionExample(
                input="Remove this feed: https://news.ycombinator.com/rss",
                output="Removing the RSS feed",
            ),
        ]
