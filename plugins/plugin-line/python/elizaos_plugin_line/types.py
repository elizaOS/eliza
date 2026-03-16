"""
Type definitions for the LINE plugin.
"""

import re
from dataclasses import dataclass, field

# Constants
MAX_LINE_MESSAGE_LENGTH = 5000
MAX_LINE_BATCH_SIZE = 5
LINE_SERVICE_NAME = "line"

# Regex patterns
HEX_PATTERN = re.compile(r"^[a-f0-9]{32}$", re.IGNORECASE)
USER_ID_PATTERN = re.compile(r"^U[a-f0-9]{32}$", re.IGNORECASE)
GROUP_ID_PATTERN = re.compile(r"^C[a-f0-9]{32}$", re.IGNORECASE)
ROOM_ID_PATTERN = re.compile(r"^R[a-f0-9]{32}$", re.IGNORECASE)


class LineEventTypes:
    """Event types emitted by the LINE plugin."""

    MESSAGE_RECEIVED = "LINE_MESSAGE_RECEIVED"
    MESSAGE_SENT = "LINE_MESSAGE_SENT"
    FOLLOW = "LINE_FOLLOW"
    UNFOLLOW = "LINE_UNFOLLOW"
    JOIN_GROUP = "LINE_JOIN_GROUP"
    LEAVE_GROUP = "LINE_LEAVE_GROUP"
    POSTBACK = "LINE_POSTBACK"
    WEBHOOK_VERIFIED = "LINE_WEBHOOK_VERIFIED"
    CONNECTION_READY = "LINE_CONNECTION_READY"


@dataclass
class LineSettings:
    """Configuration settings for the LINE plugin."""

    channel_access_token: str = ""
    channel_secret: str = ""
    webhook_path: str = "/webhooks/line"
    dm_policy: str = "pairing"  # open, pairing, allowlist, disabled
    group_policy: str = "allowlist"  # open, allowlist, disabled
    allow_from: list[str] = field(default_factory=list)
    enabled: bool = True


@dataclass
class LineUser:
    """LINE user profile."""

    user_id: str
    display_name: str
    picture_url: str | None = None
    status_message: str | None = None
    language: str | None = None


@dataclass
class LineGroup:
    """LINE group/room info."""

    group_id: str
    group_type: str  # "group" or "room"
    group_name: str | None = None
    picture_url: str | None = None
    member_count: int | None = None


@dataclass
class LineMessage:
    """LINE message."""

    id: str
    message_type: str
    user_id: str
    timestamp: int
    text: str | None = None
    group_id: str | None = None
    room_id: str | None = None
    reply_token: str | None = None


@dataclass
class LineSendResult:
    """Result from sending a message."""

    success: bool
    message_id: str | None = None
    chat_id: str | None = None
    error: str | None = None


@dataclass
class LineFlexMessage:
    """Flex message content."""

    alt_text: str
    contents: dict


@dataclass
class LineTemplateMessage:
    """Template message content."""

    template_type: str  # buttons, confirm, carousel, image_carousel
    alt_text: str
    template: dict


@dataclass
class LineLocationMessage:
    """Location message content."""

    title: str
    address: str
    latitude: float
    longitude: float


class LinePluginError(Exception):
    """Base error for LINE plugin."""

    def __init__(self, message: str, code: str = "PLUGIN_ERROR", details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


class LineConfigurationError(LinePluginError):
    """Configuration error."""

    def __init__(self, message: str, setting: str | None = None):
        super().__init__(
            message,
            "CONFIGURATION_ERROR",
            {"setting": setting} if setting else None,
        )


class LineApiError(LinePluginError):
    """API error."""

    def __init__(self, message: str, status_code: int | None = None, body: str | None = None):
        super().__init__(
            message,
            "API_ERROR",
            {"status_code": status_code, "body": body},
        )


# Utility functions


def is_valid_line_user_id(id_str: str) -> bool:
    """Check if a string is a valid LINE user ID (U followed by 32 hex chars)."""
    return bool(USER_ID_PATTERN.match(id_str.strip()))


def is_valid_line_group_id(id_str: str) -> bool:
    """Check if a string is a valid LINE group ID (C followed by 32 hex chars)."""
    return bool(GROUP_ID_PATTERN.match(id_str.strip()))


def is_valid_line_room_id(id_str: str) -> bool:
    """Check if a string is a valid LINE room ID (R followed by 32 hex chars)."""
    return bool(ROOM_ID_PATTERN.match(id_str.strip()))


def is_valid_line_id(id_str: str) -> bool:
    """Check if a string is any valid LINE ID."""
    trimmed = id_str.strip()
    return (
        is_valid_line_user_id(trimmed)
        or is_valid_line_group_id(trimmed)
        or is_valid_line_room_id(trimmed)
    )


def normalize_line_target(target: str) -> str | None:
    """Normalize a LINE target ID (strip prefixes)."""
    trimmed = target.strip()
    if not trimmed:
        return None
    # Remove line: prefixes
    result = re.sub(r"^line:(group|room|user):", "", trimmed, flags=re.IGNORECASE)
    result = re.sub(r"^line:", "", result, flags=re.IGNORECASE)
    return result


def get_chat_type_from_id(id_str: str) -> str | None:
    """Determine the chat type from an ID."""
    trimmed = id_str.strip()
    if is_valid_line_user_id(trimmed):
        return "user"
    if is_valid_line_group_id(trimmed):
        return "group"
    if is_valid_line_room_id(trimmed):
        return "room"
    return None


def split_message_for_line(
    text: str, max_length: int = MAX_LINE_MESSAGE_LENGTH
) -> list[str]:
    """Split text for LINE messages."""
    if len(text) <= max_length:
        return [text]

    chunks = []
    remaining = text

    while remaining:
        if len(remaining) <= max_length:
            chunks.append(remaining)
            break

        # Find break point
        break_point = max_length

        # Try newline first
        newline_idx = remaining.rfind("\n", 0, max_length)
        if newline_idx > max_length // 2:
            break_point = newline_idx + 1
        else:
            # Try space
            space_idx = remaining.rfind(" ", 0, max_length)
            if space_idx > max_length // 2:
                break_point = space_idx + 1

        chunks.append(remaining[:break_point].rstrip())
        remaining = remaining[break_point:].lstrip()

    return chunks
