"""
Core types for the Farcaster plugin.

All types use Pydantic for runtime validation and Python dataclasses for structure.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

# ============================================================================
# Enums
# ============================================================================


class EmbedType(str, Enum):
    """Types of embeds that can be attached to a cast."""

    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"
    URL = "url"
    CAST = "cast"
    FRAME = "frame"
    UNKNOWN = "unknown"


class FarcasterMessageType(str, Enum):
    """Types of Farcaster messages."""

    CAST = "CAST"
    REPLY = "REPLY"


class FarcasterEventType(str, Enum):
    """Farcaster-specific event types."""

    CAST_GENERATED = "FARCASTER_CAST_GENERATED"
    MENTION_RECEIVED = "FARCASTER_MENTION_RECEIVED"
    THREAD_CAST_CREATED = "FARCASTER_THREAD_CAST_CREATED"


# ============================================================================
# Profile Types
# ============================================================================


@dataclass
class Profile:
    """Farcaster user profile."""

    fid: int
    """Farcaster ID."""

    name: str
    """Display name."""

    username: str
    """Username (handle)."""

    pfp: str | None = None
    """Profile picture URL."""

    bio: str | None = None
    """Bio text."""

    url: str | None = None
    """Profile URL."""


# ============================================================================
# Cast Types
# ============================================================================


@dataclass
class EmbedMetadata:
    """Metadata for embedded content."""

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
    """Embed attached to a cast."""

    type: EmbedType
    """Type of embed: image, video, url, cast (quote), frame."""

    url: str
    """URL of the embedded content."""

    cast_hash: str | None = None
    """For embedded casts, the cast hash."""

    metadata: EmbedMetadata | None = None
    """Metadata about the embed."""


@dataclass
class CastParent:
    """Parent cast reference for replies."""

    hash: str
    fid: int


@dataclass
class CastStats:
    """Engagement statistics for a cast."""

    recasts: int = 0
    replies: int = 0
    likes: int = 0


@dataclass
class Cast:
    """A Farcaster cast (post)."""

    hash: str
    """Cast hash (unique identifier)."""

    author_fid: int
    """Author's Farcaster ID."""

    text: str
    """Cast text content."""

    profile: Profile
    """Author's profile."""

    timestamp: datetime
    """Cast timestamp."""

    thread_id: str | None = None
    """Thread ID for conversation tracking."""

    in_reply_to: CastParent | None = None
    """Parent cast if this is a reply."""

    stats: CastStats | None = None
    """Engagement stats."""

    embeds: list[CastEmbed] = field(default_factory=list)
    """Processed embeds attached to the cast."""


@dataclass
class CastId:
    """Cast identifier."""

    hash: str
    fid: int


@dataclass
class FidRequest:
    """Request parameters for fetching casts by FID."""

    fid: int
    page_size: int = 50


@dataclass
class LastCast:
    """Last cast information for caching."""

    hash: str
    timestamp: int


# ============================================================================
# Webhook Types
# ============================================================================


@dataclass
class WebhookAuthor:
    """Author information in webhook data."""

    fid: int
    username: str | None = None


@dataclass
class WebhookCastData:
    """Cast data from webhook."""

    hash: str
    text: str | None = None
    author: WebhookAuthor | None = None
    mentioned_profiles: list[WebhookAuthor] = field(default_factory=list)
    parent_hash: str | None = None
    parent_author: WebhookAuthor | None = None


@dataclass
class NeynarWebhookData:
    """Neynar webhook data structure for cast events."""

    type: str
    data: WebhookCastData | None = None


# ============================================================================
# Constants
# ============================================================================

# Service name for registration
FARCASTER_SERVICE_NAME = "farcaster"

# Source identifier for messages
FARCASTER_SOURCE = "farcaster"

# Default configuration values
DEFAULT_MAX_CAST_LENGTH = 320
DEFAULT_POLL_INTERVAL = 120
DEFAULT_CAST_INTERVAL_MIN = 90
DEFAULT_CAST_INTERVAL_MAX = 180
DEFAULT_CAST_CACHE_TTL = 1000 * 30 * 60  # 30 minutes in ms
DEFAULT_CAST_CACHE_SIZE = 9000
