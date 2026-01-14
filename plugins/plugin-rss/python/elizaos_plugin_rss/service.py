from __future__ import annotations

from elizaos_plugin_rss.client import RssClient
from elizaos_plugin_rss.types import RssFeed


class RssService:
    """
    Minimal service wrapper for RSS/Atom feeds (TS parity: `RssService`).
    """

    service_type: str = "RSS"
    capability_description: str = "The agent is able to deal with RSS/atom feeds"

    def __init__(self, client: RssClient | None = None) -> None:
        self._client = client or RssClient()

    @property
    def client(self) -> RssClient:
        return self._client

    async def fetch_url(self, url: str) -> RssFeed:
        return await self._client.fetch_feed(url)
