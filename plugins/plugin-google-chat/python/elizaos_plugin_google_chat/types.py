"""
Type definitions for the Google Chat plugin.
"""

import re
from dataclasses import dataclass, field
from enum import Enum

# Constants
MAX_GOOGLE_CHAT_MESSAGE_LENGTH = 4000
GOOGLE_CHAT_SERVICE_NAME = "google-chat"


class GoogleChatEventTypes(str, Enum):
    """Event types emitted by the Google Chat plugin."""

    MESSAGE_RECEIVED = "GOOGLE_CHAT_MESSAGE_RECEIVED"
    MESSAGE_SENT = "GOOGLE_CHAT_MESSAGE_SENT"
    SPACE_JOINED = "GOOGLE_CHAT_SPACE_JOINED"
    SPACE_LEFT = "GOOGLE_CHAT_SPACE_LEFT"
    REACTION_RECEIVED = "GOOGLE_CHAT_REACTION_RECEIVED"
    REACTION_SENT = "GOOGLE_CHAT_REACTION_SENT"
    WEBHOOK_READY = "GOOGLE_CHAT_WEBHOOK_READY"
    CONNECTION_READY = "GOOGLE_CHAT_CONNECTION_READY"


@dataclass
class GoogleChatSettings:
    """Configuration settings for the Google Chat plugin."""

    service_account: str | None = None
    service_account_file: str | None = None
    audience_type: str = "app-url"
    audience: str = ""
    webhook_path: str = "/googlechat"
    spaces: list[str] = field(default_factory=list)
    require_mention: bool = True
    enabled: bool = True
    bot_user: str | None = None


@dataclass
class GoogleChatSpace:
    """Google Chat space information."""

    name: str
    display_name: str | None = None
    type: str = "SPACE"  # DM, ROOM, or SPACE
    single_user_bot_dm: bool = False
    threaded: bool = False
    space_type: str | None = None


@dataclass
class GoogleChatUser:
    """Google Chat user information."""

    name: str
    display_name: str | None = None
    email: str | None = None
    type: str | None = None
    domain_id: str | None = None
    is_anonymous: bool = False


@dataclass
class GoogleChatThread:
    """Google Chat thread information."""

    name: str
    thread_key: str | None = None


@dataclass
class GoogleChatAttachment:
    """Google Chat attachment."""

    name: str | None = None
    content_name: str | None = None
    content_type: str | None = None
    thumbnail_uri: str | None = None
    download_uri: str | None = None
    source: str | None = None
    resource_name: str | None = None
    attachment_upload_token: str | None = None


@dataclass
class GoogleChatAnnotation:
    """Google Chat annotation (mention, etc.)."""

    type: str | None = None
    start_index: int | None = None
    length: int | None = None
    user_mention: dict | None = None
    slash_command: dict | None = None


@dataclass
class GoogleChatMessage:
    """Google Chat message."""

    name: str
    sender: GoogleChatUser
    space: GoogleChatSpace
    create_time: str
    text: str | None = None
    argument_text: str | None = None
    thread: GoogleChatThread | None = None
    attachments: list[GoogleChatAttachment] = field(default_factory=list)
    annotations: list[GoogleChatAnnotation] = field(default_factory=list)


@dataclass
class GoogleChatEvent:
    """Google Chat webhook event."""

    type: str
    event_time: str | None = None
    space: GoogleChatSpace | None = None
    user: GoogleChatUser | None = None
    message: GoogleChatMessage | None = None


@dataclass
class GoogleChatReaction:
    """Google Chat reaction."""

    name: str | None = None
    user: GoogleChatUser | None = None
    emoji: str | None = None


@dataclass
class GoogleChatMessageSendOptions:
    """Options for sending a message."""

    space: str | None = None
    thread: str | None = None
    text: str | None = None
    attachments: list[dict] = field(default_factory=list)


@dataclass
class GoogleChatSendResult:
    """Result from sending a message."""

    success: bool
    message_name: str | None = None
    space: str | None = None
    error: str | None = None


# Custom exception classes


class GoogleChatPluginError(Exception):
    """Base error class for Google Chat plugin errors."""

    def __init__(self, message: str, code: str, cause: Exception | None = None):
        super().__init__(message)
        self.code = code
        self.cause = cause


class GoogleChatConfigurationError(GoogleChatPluginError):
    """Configuration error."""

    def __init__(
        self, message: str, setting: str | None = None, cause: Exception | None = None
    ):
        super().__init__(message, "CONFIGURATION_ERROR", cause)
        self.setting = setting


class GoogleChatApiError(GoogleChatPluginError):
    """API error."""

    def __init__(
        self, message: str, status_code: int | None = None, cause: Exception | None = None
    ):
        super().__init__(message, "API_ERROR", cause)
        self.status_code = status_code


class GoogleChatAuthenticationError(GoogleChatPluginError):
    """Authentication error."""

    def __init__(self, message: str, cause: Exception | None = None):
        super().__init__(message, "AUTHENTICATION_ERROR", cause)


# Utility functions

SPACE_NAME_REGEX = re.compile(r"^spaces/[A-Za-z0-9_-]+$")
USER_NAME_REGEX = re.compile(r"^users/[A-Za-z0-9_-]+$")
RESOURCE_ID_REGEX = re.compile(r"^[A-Za-z0-9_-]+$")


def is_valid_google_chat_space_name(name: str) -> bool:
    """Check if a string is a valid Google Chat space name."""
    return bool(SPACE_NAME_REGEX.match(name))


def is_valid_google_chat_user_name(name: str) -> bool:
    """Check if a string is a valid Google Chat user name."""
    return bool(USER_NAME_REGEX.match(name))


def normalize_space_target(target: str) -> str | None:
    """Normalize a Google Chat space target."""
    trimmed = target.strip()
    if not trimmed:
        return None
    if trimmed.startswith("spaces/"):
        return trimmed
    if RESOURCE_ID_REGEX.match(trimmed):
        return f"spaces/{trimmed}"
    return None


def normalize_user_target(target: str) -> str | None:
    """Normalize a Google Chat user target."""
    trimmed = target.strip()
    if not trimmed:
        return None
    if trimmed.startswith("users/"):
        return trimmed
    if RESOURCE_ID_REGEX.match(trimmed):
        return f"users/{trimmed}"
    return None


def extract_resource_id(resource_name: str) -> str:
    """Extract the ID from a Google Chat resource name."""
    parts = resource_name.split("/")
    return parts[-1] if parts else resource_name


def get_user_display_name(user: GoogleChatUser) -> str:
    """Get display name for a user."""
    return user.display_name or extract_resource_id(user.name)


def get_space_display_name(space: GoogleChatSpace) -> str:
    """Get display name for a space."""
    return space.display_name or extract_resource_id(space.name)


def is_direct_message(space: GoogleChatSpace) -> bool:
    """Check if a space is a DM."""
    return space.type == "DM" or space.single_user_bot_dm


def split_message_for_google_chat(
    text: str, max_length: int = MAX_GOOGLE_CHAT_MESSAGE_LENGTH
) -> list[str]:
    """Split long text into chunks for Google Chat."""
    if len(text) <= max_length:
        return [text]

    chunks: list[str] = []
    remaining = text

    while remaining:
        if len(remaining) <= max_length:
            chunks.append(remaining)
            break

        # Find a good break point
        break_point = max_length
        newline_index = remaining.rfind("\n", 0, max_length)
        if newline_index > max_length * 0.5:
            break_point = newline_index + 1
        else:
            space_index = remaining.rfind(" ", 0, max_length)
            if space_index > max_length * 0.5:
                break_point = space_index + 1

        chunks.append(remaining[:break_point].rstrip())
        remaining = remaining[break_point:].lstrip()

    return chunks
