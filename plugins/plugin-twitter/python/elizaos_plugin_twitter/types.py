"""
Twitter/X Plugin Types

Type definitions for Twitter API v2 integration.
All types use Pydantic for validation and serialization.
"""

from __future__ import annotations

import os
from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


# ============================================================================
# Enums
# ============================================================================


class AuthMode(str, Enum):
    """Twitter authentication mode."""

    ENV = "env"
    OAUTH = "oauth"
    BROKER = "broker"


class SearchMode(str, Enum):
    """Twitter search mode."""

    TOP = "top"
    LATEST = "latest"
    PHOTOS = "photos"
    VIDEOS = "videos"


# ============================================================================
# Configuration
# ============================================================================


class TwitterConfig(BaseModel):
    """Twitter API v2 configuration."""

    # Authentication mode
    auth_mode: AuthMode = Field(default=AuthMode.ENV)

    # OAuth 1.0a credentials (env mode)
    api_key: str = Field(default="")
    api_secret_key: str = Field(default="")
    access_token: str = Field(default="")
    access_token_secret: str = Field(default="")

    # Bearer token (app-only auth)
    bearer_token: str = Field(default="")

    # OAuth 2.0 PKCE (oauth mode)
    client_id: str = Field(default="")
    redirect_uri: str = Field(default="")
    scopes: str = Field(default="tweet.read tweet.write users.read offline.access")

    # Broker (broker mode)
    broker_url: str = Field(default="")

    # Features
    dry_run: bool = Field(default=False)
    enable_post: bool = Field(default=False)
    enable_replies: bool = Field(default=True)
    enable_actions: bool = Field(default=False)

    # Limits
    max_tweet_length: int = Field(default=280)
    retry_limit: int = Field(default=5)
    timeout: float = Field(default=30.0)

    @classmethod
    def from_env(cls) -> "TwitterConfig":
        """Create configuration from environment variables."""
        return cls(
            auth_mode=AuthMode(os.getenv("TWITTER_AUTH_MODE", "env").lower()),
            api_key=os.getenv("TWITTER_API_KEY", ""),
            api_secret_key=os.getenv("TWITTER_API_SECRET_KEY", ""),
            access_token=os.getenv("TWITTER_ACCESS_TOKEN", ""),
            access_token_secret=os.getenv("TWITTER_ACCESS_TOKEN_SECRET", ""),
            bearer_token=os.getenv("TWITTER_BEARER_TOKEN", ""),
            client_id=os.getenv("TWITTER_CLIENT_ID", ""),
            redirect_uri=os.getenv("TWITTER_REDIRECT_URI", ""),
            scopes=os.getenv("TWITTER_SCOPES", "tweet.read tweet.write users.read offline.access"),
            broker_url=os.getenv("TWITTER_BROKER_URL", ""),
            dry_run=os.getenv("TWITTER_DRY_RUN", "false").lower() == "true",
            enable_post=os.getenv("TWITTER_ENABLE_POST", "false").lower() == "true",
            enable_replies=os.getenv("TWITTER_ENABLE_REPLIES", "true").lower() == "true",
            enable_actions=os.getenv("TWITTER_ENABLE_ACTIONS", "false").lower() == "true",
            max_tweet_length=int(os.getenv("TWITTER_MAX_TWEET_LENGTH", "280")),
            retry_limit=int(os.getenv("TWITTER_RETRY_LIMIT", "5")),
        )

    def validate_credentials(self) -> None:
        """Validate that required credentials are present for the auth mode."""
        if self.auth_mode == AuthMode.ENV:
            required = ["api_key", "api_secret_key", "access_token", "access_token_secret"]
            missing = [f for f in required if not getattr(self, f)]
            if missing:
                msg = f"Missing required credentials for env auth: {', '.join(missing)}"
                raise ValueError(msg)
        elif self.auth_mode == AuthMode.OAUTH:
            if not self.client_id or not self.redirect_uri:
                msg = "Missing client_id or redirect_uri for OAuth mode"
                raise ValueError(msg)
        elif self.auth_mode == AuthMode.BROKER:
            if not self.broker_url:
                msg = "Missing broker_url for broker mode"
                raise ValueError(msg)


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
    """User mention in a tweet."""

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
    """Poll data for a tweet."""

    id: str | None = None
    end_datetime: datetime | None = None
    voting_status: str | None = None
    duration_minutes: int
    options: list[PollOption]


# ============================================================================
# User Types
# ============================================================================


class Profile(BaseModel):
    """Twitter user profile."""

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
    tweet_count: int = 0
    listed_count: int = 0


# ============================================================================
# Tweet Types
# ============================================================================


class TweetMetrics(BaseModel):
    """Tweet public metrics."""

    like_count: int = 0
    retweet_count: int = 0
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


class Tweet(BaseModel):
    """Parsed tweet from Twitter API v2."""

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
    metrics: TweetMetrics = Field(default_factory=TweetMetrics)

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
    in_reply_to_status_id: str | None = None
    quoted_status_id: str | None = None
    retweeted_status_id: str | None = None

    # Flags
    is_reply: bool = False
    is_retweet: bool = False
    is_quote: bool = False
    is_self_thread: bool = False
    is_sensitive: bool = False

    # Thread
    thread: list["Tweet"] = Field(default_factory=list)

    # Computed
    permanent_url: str = ""
    timestamp: int = 0

    def model_post_init(self, __context: object) -> None:
        """Compute derived fields."""
        if not self.permanent_url and self.id:
            self.permanent_url = f"https://twitter.com/i/status/{self.id}"
        if not self.timestamp and self.created_at:
            self.timestamp = int(self.created_at.timestamp())


# ============================================================================
# Response Types
# ============================================================================


class QueryTweetsResponse(BaseModel):
    """Response from tweet query endpoints."""

    tweets: list[Tweet]
    next_token: str | None = None


class QueryProfilesResponse(BaseModel):
    """Response from profile query endpoints."""

    profiles: list[Profile]
    next_token: str | None = None


# ============================================================================
# Action Types
# ============================================================================


class ActionResponse(BaseModel):
    """Response from timeline actions."""

    like: bool = False
    retweet: bool = False
    quote: bool = False
    reply: bool = False


class TweetCreateResult(BaseModel):
    """Result of creating a tweet."""

    id: str
    text: str

