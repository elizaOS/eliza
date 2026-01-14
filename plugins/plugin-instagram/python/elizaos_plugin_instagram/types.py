from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class InstagramEventType(str, Enum):
    MESSAGE_RECEIVED = "INSTAGRAM_MESSAGE_RECEIVED"
    MESSAGE_SENT = "INSTAGRAM_MESSAGE_SENT"

    # Post events
    COMMENT_RECEIVED = "INSTAGRAM_COMMENT_RECEIVED"
    LIKE_RECEIVED = "INSTAGRAM_LIKE_RECEIVED"

    # User events
    FOLLOW_RECEIVED = "INSTAGRAM_FOLLOW_RECEIVED"
    UNFOLLOW_RECEIVED = "INSTAGRAM_UNFOLLOW_RECEIVED"

    # Story events
    STORY_VIEWED = "INSTAGRAM_STORY_VIEWED"
    STORY_REPLY_RECEIVED = "INSTAGRAM_STORY_REPLY_RECEIVED"


class InstagramMediaType(str, Enum):
    PHOTO = "photo"
    VIDEO = "video"
    CAROUSEL = "carousel"
    REEL = "reel"
    STORY = "story"
    IGTV = "igtv"


class InstagramUser(BaseModel):
    pk: int
    username: str
    full_name: str | None = None
    profile_pic_url: str | None = None
    is_private: bool = False
    is_verified: bool = False
    follower_count: int | None = None
    following_count: int | None = None


class InstagramMedia(BaseModel):
    pk: int
    media_type: InstagramMediaType
    caption: str | None = None
    url: str | None = None
    thumbnail_url: str | None = None
    like_count: int = 0
    comment_count: int = 0
    taken_at: datetime | None = None
    user: InstagramUser | None = None


class InstagramMessage(BaseModel):
    id: str
    thread_id: str
    text: str | None = None
    timestamp: datetime
    user: InstagramUser
    media: InstagramMedia | None = None
    is_seen: bool = False


class InstagramComment(BaseModel):
    pk: int
    text: str
    created_at: datetime
    user: InstagramUser
    media_pk: int
    reply_to_pk: int | None = None


class InstagramThread(BaseModel):
    id: str
    users: list[InstagramUser] = Field(default_factory=list)
    last_activity_at: datetime | None = None
    is_group: bool = False
    thread_title: str | None = None
