from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_rss.actions.get_feed import ActionExample


@dataclass
class ListFeedsAction:
    @property
    def name(self) -> str:
        return "LIST_RSS_FEEDS"

    @property
    def similes(self) -> list[str]:
        return ["SHOW_RSS_FEEDS", "GET_RSS_FEEDS", "RSS_SUBSCRIPTIONS"]

    @property
    def description(self) -> str:
        return "List all subscribed RSS/Atom feeds"

    def _is_list_request(self, text: str) -> bool:
        lower = text.lower()
        has_action = any(word in lower for word in ["list", "show", "what", "subscrib"])
        has_target = any(word in lower for word in ["rss", "feed"])
        return has_action and has_target

    async def validate(self, message_text: str) -> bool:
        return self._is_list_request(message_text)

    async def handler(self, params: dict[str, object]) -> dict[str, object]:
        return {
            "action": "LIST_RSS_FEEDS",
            "status": "pending_list",
        }

    @property
    def examples(self) -> list[ActionExample]:
        return [
            ActionExample(
                input="What RSS feeds am I subscribed to?",
                output="Let me check your RSS subscriptions",
            ),
            ActionExample(
                input="Show me my feeds",
                output="Here are your RSS feeds",
            ),
        ]
