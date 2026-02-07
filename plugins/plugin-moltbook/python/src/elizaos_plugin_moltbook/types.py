"""Type definitions for the Moltbook plugin."""

from dataclasses import dataclass, field
from typing import TypedDict


# ==================== Config ====================


@dataclass
class MoltbookConfig:
    """Configuration for the Moltbook service."""

    agent_name: str
    moltbook_token: str | None = None
    autonomous_mode: bool = False
    autonomy_interval_ms: int | None = None
    autonomy_max_steps: int | None = None


# ==================== API Data Types ====================


class MoltbookAuthorData(TypedDict, total=False):
    name: str


class MoltbookSubmoltRefData(TypedDict, total=False):
    name: str


class MoltbookPostData(TypedDict, total=False):
    id: str
    title: str
    content: str | None
    body: str | None
    submolt: MoltbookSubmoltRefData | None
    author: MoltbookAuthorData | None
    upvotes: int
    comment_count: int
    created_at: str | None


class MoltbookCommentData(TypedDict, total=False):
    id: str
    content: str
    author: MoltbookAuthorData | None
    created_at: str | None
    parent_id: str | None


class MoltbookSubmoltData(TypedDict, total=False):
    id: str
    name: str
    description: str | None
    subscriber_count: int
    post_count: int
    created_at: str | None
    icon_url: str | None


# ==================== Result Type ====================


@dataclass
class MoltbookResult:
    """Result type for API operations that can fail."""

    success: bool
    data: list[MoltbookPostData] | list[MoltbookSubmoltData] | MoltbookSubmoltData | None = None
    error: str | None = None


def moltbook_success(
    data: list[MoltbookPostData] | list[MoltbookSubmoltData] | MoltbookSubmoltData | None,
) -> MoltbookResult:
    """Create a successful result."""
    return MoltbookResult(success=True, data=data)


def moltbook_failure(error: str) -> MoltbookResult:
    """Create a failed result."""
    return MoltbookResult(success=False, error=error)


# ==================== Post With Comments ====================


@dataclass
class PostWithComments:
    """Result of reading a post with its comments."""

    post: MoltbookPostData
    comments: list[MoltbookCommentData] = field(default_factory=list)


# ==================== Event Types ====================


class MoltbookEventTypes:
    POST_CREATED = "moltbook.post.created"
    COMMENT_CREATED = "moltbook.comment.created"
    POSTS_BROWSED = "moltbook.posts.browsed"
    POST_READ = "moltbook.post.read"
    AUTONOMY_STEP_COMPLETED = "moltbook.autonomy.step.completed"
    AUTONOMY_STARTED = "moltbook.autonomy.started"
    AUTONOMY_STOPPED = "moltbook.autonomy.stopped"


# ==================== Payload Types ====================


@dataclass
class MoltbookPostPayload:
    post_id: str
    submolt: str
    title: str


@dataclass
class MoltbookCommentPayload:
    comment_id: str
    post_id: str
    parent_id: str | None = None


@dataclass
class MoltbookAutonomyStepPayload:
    step_number: int
    action: str
    result: str
    timestamp: str


# ==================== Error Types ====================


class MoltbookAPIError(Exception):
    """Error from the Moltbook API."""

    def __init__(
        self,
        message: str,
        status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


class MoltbookAuthenticationError(MoltbookAPIError):
    """Authentication error - token missing or invalid."""

    def __init__(self, message: str) -> None:
        super().__init__(message, status=401)


class MoltbookContentTooLongError(MoltbookAPIError):
    """Content exceeds maximum allowed length."""

    def __init__(self, message: str) -> None:
        super().__init__(message, status=400)


class MoltbookConfigurationError(MoltbookAPIError):
    """Configuration error - invalid settings."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
