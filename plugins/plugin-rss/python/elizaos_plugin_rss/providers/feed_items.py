from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ProviderParams:
    conversation_id: str
    agent_id: str


@dataclass
class ProviderResult:
    values: dict[str, str]
    text: str
    data: dict[str, object]


@dataclass
class FeedItemsProvider:
    @property
    def name(self) -> str:
        return "FEEDITEMS"

    @property
    def description(self) -> str:
        return "Provides recent news and articles from subscribed RSS feeds"

    @property
    def position(self) -> int:
        return 50

    async def get(self, params: ProviderParams) -> ProviderResult:
        values = {
            "itemCount": "0",
            "feedCount": "0",
        }

        text = "No RSS feed items available. Subscribe to feeds to see news articles here."

        data: dict[str, object] = {
            "count": 0,
            "totalCount": 0,
            "feedCount": 0,
        }

        return ProviderResult(values=values, text=text, data=data)
