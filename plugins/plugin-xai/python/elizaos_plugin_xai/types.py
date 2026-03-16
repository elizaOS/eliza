"""
xAI Plugin Types

Type definitions for xAI Grok and X (formerly Twitter) API integration.
All types use Pydantic for validation and serialization.
"""

from __future__ import annotations

import os
from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field

# ============================================================================
# Enums
# ============================================================================


class AuthMode(str, Enum):
    """X authentication mode."""

    ENV = "env"
    OAUTH = "oauth"
    BEARER = "bearer"


class SearchMode(str, Enum):
    """X search mode."""

    TOP = "top"
    LATEST = "latest"
    PHOTOS = "photos"
    VIDEOS = "videos"


# ============================================================================
# X Configuration
# ============================================================================


class TwitterConfig(BaseModel):
    """X (formerly Twitter) API v2 configuration."""

    auth_mode: AuthMode = Field(default=AuthMode.ENV)

    # OAuth 1.0a credentials (env mode)
    api_key: str = Field(default="")
    api_secret: str = Field(default="")
    access_token: str = Field(default="")
    access_token_secret: str = Field(default="")

    # Bearer token (bearer mode)
    bearer_token: str = Field(default="")

    # OAuth 2.0 PKCE (oauth mode)
    client_id: str = Field(default="")
    redirect_uri: str = Field(default="")

    # Features
    dry_run: bool = Field(default=False)
    enable_post: bool = Field(default=False)
    enable_replies: bool = Field(default=True)
    enable_actions: bool = Field(default=False)

    # Limits
    max_post_length: int = Field(default=280)
    retry_limit: int = Field(default=5)
    timeout: float = Field(default=30.0)

    @classmethod
    def from_env(cls) -> TwitterConfig:
        """Create configuration from environment variables."""
        return cls(
            auth_mode=AuthMode(os.getenv("X_AUTH_MODE", "env").lower()),
            api_key=os.getenv("X_API_KEY", ""),
            api_secret=os.getenv("X_API_SECRET", ""),
            access_token=os.getenv("X_ACCESS_TOKEN", ""),
            access_token_secret=os.getenv("X_ACCESS_TOKEN_SECRET", ""),
            bearer_token=os.getenv("X_BEARER_TOKEN", ""),
            client_id=os.getenv("X_CLIENT_ID", ""),
            redirect_uri=os.getenv("X_REDIRECT_URI", ""),
            dry_run=os.getenv("X_DRY_RUN", "false").lower() == "true",
            enable_post=os.getenv("X_ENABLE_POST", "false").lower() == "true",
            enable_replies=os.getenv("X_ENABLE_REPLIES", "true").lower() == "true",
            enable_actions=os.getenv("X_ENABLE_ACTIONS", "false").lower() == "true",
            max_post_length=int(os.getenv("X_MAX_POST_LENGTH", "280")),
            retry_limit=int(os.getenv("X_RETRY_LIMIT", "5")),
        )

    def validate_credentials(self) -> None:
        """Validate that required credentials are present."""
        if self.auth_mode == AuthMode.ENV:
            required = ["api_key", "api_secret", "access_token", "access_token_secret"]
            missing = [f for f in required if not getattr(self, f)]
            if missing:
                raise ValueError(f"Missing credentials for env auth: {', '.join(missing)}")
        elif self.auth_mode == AuthMode.BEARER:
            if not self.bearer_token:
                raise ValueError("Missing bearer_token for bearer auth")
        elif self.auth_mode == AuthMode.OAUTH:
            if not self.client_id or not self.redirect_uri:
                raise ValueError("Missing client_id or redirect_uri for OAuth mode")


# ============================================================================
# Media Types
# ============================================================================


class Photo(BaseModel):
    """Photo attachment."""

    id: str
    url: str
    alt_text: str | None = None


class Video(BaseModel):
    """Video attachment."""

    id: str
    preview: str
    url: str | None = None
    duration_ms: int | None = None


class Mention(BaseModel):
    """User mention in a post."""

    id: str
    username: str | None = None
    name: str | None = None


# ============================================================================
# Poll Types
# ============================================================================


class PollOption(BaseModel):
    """Poll option."""

    position: int | None = None
    label: str
    votes: int | None = None


class PollData(BaseModel):
    """Poll data for a post."""

    id: str | None = None
    end_datetime: datetime | None = None
    voting_status: str | None = None
    duration_minutes: int
    options: list[PollOption]


# ============================================================================
# User Types
# ============================================================================


class Profile(BaseModel):
    """X user profile."""

    id: str
    username: str
    name: str
    description: str | None = None
    location: str | None = None
    url: str | None = None
    profile_image_url: str | None = None
    verified: bool = False
    protected: bool = False
    created_at: datetime | None = None
    followers_count: int = 0
    following_count: int = 0
    post_count: int = 0
    listed_count: int = 0


# ============================================================================
# Post Types
# ============================================================================


class PostMetrics(BaseModel):
    """Post public metrics."""

    like_count: int = 0
    repost_count: int = 0
    reply_count: int = 0
    quote_count: int = 0
    impression_count: int = 0
    bookmark_count: int = 0


class PlaceData(BaseModel):
    """Place/location data."""

    id: str | None = None
    name: str | None = None
    full_name: str | None = None
    country: str | None = None
    country_code: str | None = None
    place_type: str | None = None


class Post(BaseModel):
    """Parsed post from X API v2."""

    id: str
    text: str
    author_id: str | None = None
    conversation_id: str | None = None
    created_at: datetime | None = None
    language: str | None = None

    # Author info (from includes)
    username: str = ""
    name: str = ""

    # Metrics
    metrics: PostMetrics = Field(default_factory=PostMetrics)

    # Entities
    hashtags: list[str] = Field(default_factory=list)
    mentions: list[Mention] = Field(default_factory=list)
    urls: list[str] = Field(default_factory=list)

    # Media
    photos: list[Photo] = Field(default_factory=list)
    videos: list[Video] = Field(default_factory=list)

    # Poll
    poll: PollData | None = None

    # Place
    place: PlaceData | None = None

    # References
    in_reply_to_id: str | None = None
    quoted_id: str | None = None
    reposted_id: str | None = None

    # Flags
    is_reply: bool = False
    is_repost: bool = False
    is_quote: bool = False
    is_sensitive: bool = False

    # Thread
    thread: list[Post] = Field(default_factory=list)

    # Computed
    permanent_url: str = ""
    timestamp: int = 0

    def model_post_init(self, __context: object) -> None:
        """Compute derived fields."""
        if not self.permanent_url and self.id:
            self.permanent_url = f"https://x.com/i/status/{self.id}"
        if not self.timestamp and self.created_at:
            self.timestamp = int(self.created_at.timestamp())


# ============================================================================
# Response Types
# ============================================================================


class QueryPostsResponse(BaseModel):
    """Response from post query endpoints."""

    posts: list[Post]
    next_token: str | None = None


class QueryProfilesResponse(BaseModel):
    """Response from profile query endpoints."""

    profiles: list[Profile]
    next_token: str | None = None


class ActionResponse(BaseModel):
    """Response from timeline actions."""

    like: bool = False
    repost: bool = False
    quote: bool = False
    reply: bool = False


class PostCreateResult(BaseModel):
    """Result of creating a post."""

    id: str
    text: str
