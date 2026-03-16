from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

from elizaos_plugin_rss.client import RssClient, RssClientError
from elizaos_plugin_rss.types import (
    FeedFormat,
    FeedItemMetadata,
    FeedSubscriptionMetadata,
    RssConfig,
    RssFeed,
)


@dataclass
class RssPlugin:
    config: RssConfig = field(default_factory=RssConfig)
    client: RssClient | None = None
    subscribed_feeds: dict[str, FeedSubscriptionMetadata] = field(default_factory=dict)
    feed_items: dict[str, FeedItemMetadata] = field(default_factory=dict)

    def __post_init__(self) -> None:
        rss_feeds = os.environ.get("RSS_FEEDS", "")
        if rss_feeds:
            try:
                feeds = json.loads(rss_feeds)
                if isinstance(feeds, list):
                    self.config.feeds = feeds
            except json.JSONDecodeError:
                self.config.feeds = [f.strip() for f in rss_feeds.split(",") if f.strip()]

        if os.environ.get("RSS_DISABLE_ACTIONS", "").lower() == "true":
            self.config.disable_actions = True

        feed_format = os.environ.get("RSS_FEED_FORMAT", "csv")
        self.config.feed_format = (
            FeedFormat(feed_format) if feed_format in ("csv", "markdown") else FeedFormat.CSV
        )

        interval = os.environ.get("RSS_CHECK_INTERVAL_MINUTES")
        if interval:
            try:
                self.config.check_interval_minutes = int(interval)
            except ValueError:
                pass

    async def start(self) -> None:
        self.client = RssClient(self.config)
        for url in self.config.feeds:
            await self.subscribe_feed(url)

    async def stop(self) -> None:
        if self.client:
            await self.client.close()
            self.client = None

    async def __aenter__(self) -> RssPlugin:
        await self.start()
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.stop()

    async def fetch_feed(self, url: str) -> RssFeed | None:
        if not self.client:
            self.client = RssClient(self.config)

        try:
            return await self.client.fetch_feed(url)
        except RssClientError:
            return None

    async def subscribe_feed(self, url: str, title: str | None = None) -> bool:
        if url in self.subscribed_feeds:
            return True

        feed_title = title
        if not feed_title:
            feed = await self.fetch_feed(url)
            if feed:
                feed_title = feed.title

        import time

        self.subscribed_feeds[url] = FeedSubscriptionMetadata(
            type="feed_subscription",
            subscribedAt=int(time.time() * 1000),
            lastChecked=0,
            lastItemCount=0,
        )

        return True

    async def unsubscribe_feed(self, url: str) -> bool:
        if url not in self.subscribed_feeds:
            return False

        del self.subscribed_feeds[url]
        return True

    def get_subscribed_feeds(self) -> list[tuple[str, FeedSubscriptionMetadata]]:
        return list(self.subscribed_feeds.items())

    async def check_all_feeds(self) -> dict[str, int]:
        import time

        results: dict[str, int] = {}

        for url, metadata in self.subscribed_feeds.items():
            feed = await self.fetch_feed(url)
            if not feed:
                continue

            new_items = 0
            for item in feed.items:
                item_id = f"{url}_{item.guid or item.title}_{item.pub_date}"
                if item_id not in self.feed_items:
                    self.feed_items[item_id] = FeedItemMetadata(
                        title=item.title,
                        description=item.description,
                        pubDate=item.pub_date,
                        author=item.author,
                        feedUrl=url,
                        feedTitle=feed.title,
                        link=item.link,
                        category=item.category,
                        type="feed_item",
                    )
                    new_items += 1

            # Update subscription metadata
            self.subscribed_feeds[url] = FeedSubscriptionMetadata(
                type="feed_subscription",
                subscribedAt=metadata.subscribed_at,
                lastChecked=int(time.time() * 1000),
                lastItemCount=len(feed.items),
            )

            results[url] = new_items

        return results

    def get_feed_items(self, limit: int = 50) -> list[FeedItemMetadata]:
        items = list(self.feed_items.values())
        items.sort(key=lambda x: x.pub_date or "", reverse=True)
        return items[:limit]

    def format_feed_items(self, items: list[FeedItemMetadata] | None = None) -> str:
        if items is None:
            items = self.get_feed_items()

        if not items:
            return "No RSS feed items available."

        by_feed: dict[str, list[FeedItemMetadata]] = {}
        for item in items:
            feed_title = item.feed_title or "Unknown Feed"
            if feed_title not in by_feed:
                by_feed[feed_title] = []
            by_feed[feed_title].append(item)

        if self.config.feed_format == FeedFormat.MARKDOWN:
            return self._format_markdown(items, by_feed)
        else:
            return self._format_csv(items, by_feed)

    def _format_markdown(
        self, items: list[FeedItemMetadata], by_feed: dict[str, list[FeedItemMetadata]]
    ) -> str:
        output = f"# Recent RSS Feed Items ({len(items)} items from {len(by_feed)} feeds)\n\n"

        for feed_title, feed_items in by_feed.items():
            output += f"## {feed_title} ({len(feed_items)} items)\n\n"

            for item in feed_items:
                title = item.title or "Untitled"
                output += f"### {title}\n"
                if item.link:
                    output += f"- URL: {item.link}\n"
                if item.pub_date:
                    output += f"- Published: {item.pub_date}\n"
                if item.author:
                    output += f"- Author: {item.author}\n"
                if item.description:
                    desc = (
                        item.description[:200] + "..."
                        if len(item.description) > 200
                        else item.description
                    )
                    output += f"- Description: {desc}\n"
                output += "\n"

        return output

    def _format_csv(
        self, items: list[FeedItemMetadata], by_feed: dict[str, list[FeedItemMetadata]]
    ) -> str:
        output = f"# RSS Feed Items ({len(items)} from {len(by_feed)} feeds)\n"
        output += "Feed,Title,URL,Published,Description\n"

        for item in items:
            feed = (item.feed_title or "Unknown").replace('"', '""')
            title = (item.title or "").replace('"', '""')
            url = item.link or ""
            pub_date = item.pub_date or ""
            desc = (item.description or "").replace('"', '""')[:200]

            output += f'"{feed}","{title}","{url}","{pub_date}","{desc}"\n'

        return output


def create_plugin(config: RssConfig | None = None) -> RssPlugin:
    return RssPlugin(config=config or RssConfig())


def get_rss_plugin() -> RssPlugin:
    return RssPlugin()
