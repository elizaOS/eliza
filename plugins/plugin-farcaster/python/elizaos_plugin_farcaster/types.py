from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class EmbedType(str, Enum):
    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"
    URL = "url"
    CAST = "cast"
    FRAME = "frame"
    UNKNOWN = "unknown"


class FarcasterMessageType(str, Enum):
    CAST = "CAST"
    REPLY = "REPLY"


class FarcasterEventType(str, Enum):
    CAST_GENERATED = "FARCASTER_CAST_GENERATED"
    MENTION_RECEIVED = "FARCASTER_MENTION_RECEIVED"
    THREAD_CAST_CREATED = "FARCASTER_THREAD_CAST_CREATED"


@dataclass
class Profile:
    fid: int
    name: str
    username: str
    pfp: str | None = None
    bio: str | None = None
    url: str | None = None


@dataclass
class EmbedMetadata:
    content_type: str | None = None
    width: int | None = None
    height: int | None = None
    duration: int | None = None
    title: str | None = None
    description: str | None = None
    author_fid: int | None = None
    author_username: str | None = None


@dataclass
class CastEmbed:
    type: EmbedType
    url: str
    cast_hash: str | None = None
    metadata: EmbedMetadata | None = None


@dataclass
class CastParent:
    hash: str
    fid: int


@dataclass
class CastStats:
    recasts: int = 0
    replies: int = 0
    likes: int = 0


@dataclass
class Cast:
    hash: str
    author_fid: int
    text: str
    profile: Profile
    timestamp: datetime
    thread_id: str | None = None
    in_reply_to: CastParent | None = None
    stats: CastStats | None = None
    embeds: list[CastEmbed] = field(default_factory=list)


@dataclass
class CastId:
    hash: str
    fid: int


@dataclass
class FidRequest:
    fid: int
    page_size: int = 50


@dataclass
class LastCast:
    hash: str
    timestamp: int


@dataclass
class WebhookAuthor:
    fid: int
    username: str | None = None


@dataclass
class WebhookCastData:
    hash: str
    text: str | None = None
    author: WebhookAuthor | None = None
    mentioned_profiles: list[WebhookAuthor] = field(default_factory=list)
    parent_hash: str | None = None
    parent_author: WebhookAuthor | None = None


@dataclass
class NeynarWebhookData:
    type: str
    data: WebhookCastData | None = None


FARCASTER_SERVICE_NAME = "farcaster"
FARCASTER_SOURCE = "farcaster"
DEFAULT_MAX_CAST_LENGTH = 320
DEFAULT_POLL_INTERVAL = 120
DEFAULT_CAST_INTERVAL_MIN = 90
DEFAULT_CAST_INTERVAL_MAX = 180
DEFAULT_CAST_CACHE_TTL = 1000 * 30 * 60  # 30 minutes in ms
DEFAULT_CAST_CACHE_SIZE = 9000
