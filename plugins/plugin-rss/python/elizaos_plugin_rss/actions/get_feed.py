from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ActionExample:
    input: str
    output: str


@dataclass
class GetFeedAction:
    @property
    def name(self) -> str:
        return "GET_NEWSFEED"

    @property
    def similes(self) -> list[str]:
        return ["FETCH_RSS", "READ_FEED", "DOWNLOAD_FEED"]

    @property
    def description(self) -> str:
        return "Download and parse an RSS/Atom feed from a URL"

    async def validate(self, message_text: str) -> bool:
        return True

    async def handler(self, params: dict[str, object]) -> dict[str, object]:
        url = params.get("url")
        if not url or not isinstance(url, str):
            raise ValueError("Missing 'url' parameter")

        return {
            "action": "GET_NEWSFEED",
            "url": url,
            "status": "pending_fetch",
        }

    @property
    def examples(self) -> list[ActionExample]:
        return [
            ActionExample(
                input="Read https://server.com/feed.rss",
                output="I'll check that out",
            ),
            ActionExample(
                input="Fetch the news from https://news.ycombinator.com/rss",
                output="Fetching the Hacker News feed now",
            ),
        ]
