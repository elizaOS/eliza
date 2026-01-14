from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field

# Constants
BLUESKY_SERVICE_URL = "https://bsky.social"
BLUESKY_MAX_POST_LENGTH = 300
BLUESKY_POLL_INTERVAL = 60
BLUESKY_POST_INTERVAL_MIN = 1800
BLUESKY_POST_INTERVAL_MAX = 3600
BLUESKY_ACTION_INTERVAL = 120
BLUESKY_MAX_ACTIONS = 5
BLUESKY_CHAT_SERVICE_DID = "did:web:api.bsky.chat"


class NotificationReason(str, Enum):
    MENTION = "mention"
    REPLY = "reply"
    FOLLOW = "follow"
    LIKE = "like"
    REPOST = "repost"
    QUOTE = "quote"


class BlueSkyProfile(BaseModel):
    did: str
    handle: str
    display_name: str | None = None
    description: str | None = None
    avatar: str | None = None
    banner: str | None = None
    followers_count: int | None = None
    follows_count: int | None = None
    posts_count: int | None = None
    indexed_at: str | None = None
    created_at: str | None = None


class PostFacet(BaseModel):
    index: dict[str, int]
    features: list[dict[str, str | int | float | bool | dict | list | None]]


class PostRecord(BaseModel):
    type_field: str = Field(alias="$type", default="app.bsky.feed.post")
    text: str
    facets: list[PostFacet] | None = None
    created_at: str = ""


class BlueSkyPost(BaseModel):
    uri: str
    cid: str
    author: BlueSkyProfile
    record: PostRecord
    reply_count: int | None = None
    repost_count: int | None = None
    like_count: int | None = None
    quote_count: int | None = None
    indexed_at: str = ""


class TimelineRequest(BaseModel):
    algorithm: str | None = None
    limit: int = 50
    cursor: str | None = None


class TimelineFeedItem(BaseModel):
    post: BlueSkyPost
    reply: dict[str, str | int | float | bool | dict | list | None] | None = None
    reason: dict[str, str | int | float | bool | dict | list | None] | None = None


class TimelineResponse(BaseModel):
    cursor: str | None = None
    feed: list[TimelineFeedItem]


class CreatePostContent(BaseModel):
    text: str
    facets: list[PostFacet] | None = None


class PostReference(BaseModel):
    uri: str
    cid: str


class CreatePostRequest(BaseModel):
    content: CreatePostContent
    reply_to: PostReference | None = None


class BlueSkyNotification(BaseModel):
    uri: str
    cid: str
    author: BlueSkyProfile
    reason: NotificationReason
    reason_subject: str | None = None
    record: dict[str, str | int | float | bool | dict | list | None]
    is_read: bool
    indexed_at: str


class BlueSkyMessage(BaseModel):
    id: str
    rev: str
    text: str | None = None
    sender: dict[str, str]
    sent_at: str


class BlueSkyConversation(BaseModel):
    id: str
    rev: str
    members: list[dict[str, str | int | float | bool | dict | list | None]]
    last_message: BlueSkyMessage | None = None
    unread_count: int
    muted: bool


class SendMessageRequest(BaseModel):
    convo_id: str
    message: dict[str, str | None]


class BlueSkySession(BaseModel):
    did: str
    handle: str
    email: str | None = None
    access_jwt: str
    refresh_jwt: str
