from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class FeedFormat(str, Enum):
    CSV = "csv"
    MARKDOWN = "markdown"


class RssImage(BaseModel):
    url: str = Field(default="", description="URL of the image")
    title: str = Field(default="", description="Image title")
    link: str = Field(default="", description="Link associated with the image")
    width: str = Field(default="", description="Image width")
    height: str = Field(default="", description="Image height")


class RssEnclosure(BaseModel):
    url: str = Field(..., description="URL of the enclosed media")
    type: str = Field(default="", description="MIME type of the media")
    length: str = Field(default="", description="Size in bytes")


class RssItem(BaseModel):
    title: str = Field(default="", description="Item title")
    link: str = Field(default="", description="Item URL")
    pub_date: str = Field(default="", alias="pubDate", description="Publication date")
    description: str = Field(default="", description="Item description/summary")
    author: str = Field(default="", description="Item author")
    category: list[str] = Field(default_factory=list, description="Categories/tags")
    comments: str = Field(default="", description="URL to comments")
    guid: str = Field(default="", description="Unique identifier")
    enclosure: RssEnclosure | None = Field(default=None, description="Media attachment")

    model_config = {"populate_by_name": True}


class RssChannel(BaseModel):
    title: str = Field(default="", description="Channel title")
    description: str = Field(default="", description="Channel description")
    link: str = Field(default="", description="Channel URL")
    language: str = Field(default="", description="Channel language (ISO-639)")
    copyright: str = Field(default="", description="Copyright notice")
    last_build_date: str = Field(default="", alias="lastBuildDate", description="Last build date")
    generator: str = Field(default="", description="Generator software")
    docs: str = Field(default="", description="RSS specification URL")
    ttl: str = Field(default="", description="Time to live in minutes")
    image: RssImage | None = Field(default=None, description="Channel image")

    model_config = {"populate_by_name": True}


class RssFeed(RssChannel):
    items: list[RssItem] = Field(default_factory=list, description="Feed items")


class FeedItemMetadata(BaseModel):
    title: str | None = None
    description: str | None = None
    pub_date: str | None = Field(default=None, alias="pubDate")
    author: str | None = None
    feed_url: str | None = Field(default=None, alias="feedUrl")
    feed_title: str | None = Field(default=None, alias="feedTitle")
    link: str | None = None
    category: list[str] | None = None
    type: Literal["feed_item"] = "feed_item"

    model_config = {"populate_by_name": True}


class FeedSubscriptionMetadata(BaseModel):
    type: Literal["feed_subscription"] = "feed_subscription"
    subscribed_at: int = Field(alias="subscribedAt", description="Subscription timestamp")
    last_checked: int = Field(default=0, alias="lastChecked", description="Last check timestamp")
    last_item_count: int = Field(
        default=0, alias="lastItemCount", description="Item count at last check"
    )

    model_config = {"populate_by_name": True}


class RssConfig(BaseModel):
    feeds: list[str] = Field(
        default_factory=list, description="List of feed URLs to auto-subscribe"
    )
    disable_actions: bool = Field(
        default=False, description="Disable subscription management actions"
    )
    feed_format: FeedFormat = Field(
        default=FeedFormat.CSV, description="Output format for feed items"
    )
    check_interval_minutes: int = Field(
        default=15, ge=1, description="Interval between feed checks in minutes"
    )
    timeout: float = Field(default=30.0, ge=1.0, description="Request timeout in seconds")
    user_agent: str = Field(
        default="elizaOS-RSS-Plugin/1.0", description="User agent for HTTP requests"
    )
