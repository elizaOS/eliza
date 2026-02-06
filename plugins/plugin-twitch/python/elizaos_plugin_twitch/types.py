"""
Type definitions for the Twitch plugin.
"""

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

# Constants
MAX_TWITCH_MESSAGE_LENGTH = 500
TWITCH_SERVICE_NAME = "twitch"


class TwitchEventTypes(str, Enum):
    """Event types emitted by the Twitch plugin."""
    MESSAGE_RECEIVED = "TWITCH_MESSAGE_RECEIVED"
    MESSAGE_SENT = "TWITCH_MESSAGE_SENT"
    JOIN_CHANNEL = "TWITCH_JOIN_CHANNEL"
    LEAVE_CHANNEL = "TWITCH_LEAVE_CHANNEL"
    CONNECTION_READY = "TWITCH_CONNECTION_READY"
    CONNECTION_LOST = "TWITCH_CONNECTION_LOST"


# Twitch user roles for access control
TwitchRole = str  # "moderator" | "owner" | "vip" | "subscriber" | "all"


@dataclass
class TwitchSettings:
    """Configuration settings for the Twitch plugin."""
    username: str
    client_id: str
    access_token: str
    channel: str
    client_secret: Optional[str] = None
    refresh_token: Optional[str] = None
    additional_channels: list[str] = field(default_factory=list)
    require_mention: bool = False
    allowed_roles: list[str] = field(default_factory=lambda: ["all"])
    allowed_user_ids: list[str] = field(default_factory=list)
    enabled: bool = True


@dataclass
class TwitchUserInfo:
    """Information about a Twitch user."""
    user_id: str
    username: str
    display_name: str
    is_moderator: bool = False
    is_broadcaster: bool = False
    is_vip: bool = False
    is_subscriber: bool = False
    color: Optional[str] = None
    badges: dict[str, str] = field(default_factory=dict)


@dataclass
class TwitchMessage:
    """Represents a Twitch chat message."""
    id: str
    channel: str
    text: str
    user: TwitchUserInfo
    timestamp: float
    is_action: bool = False
    is_highlighted: bool = False
    reply_to: Optional[dict] = None


@dataclass
class TwitchMessageSendOptions:
    """Options for sending a message."""
    channel: Optional[str] = None
    reply_to: Optional[str] = None


@dataclass
class TwitchSendResult:
    """Result from sending a message."""
    success: bool
    message_id: Optional[str] = None
    error: Optional[str] = None


# Custom Exceptions
class TwitchPluginError(Exception):
    """Base exception for Twitch plugin errors."""
    pass


class TwitchServiceNotInitializedError(TwitchPluginError):
    """Raised when the Twitch service is not initialized."""
    def __init__(self, message: str = "Twitch service is not initialized"):
        super().__init__(message)


class TwitchNotConnectedError(TwitchPluginError):
    """Raised when the Twitch client is not connected."""
    def __init__(self, message: str = "Twitch client is not connected"):
        super().__init__(message)


class TwitchConfigurationError(TwitchPluginError):
    """Raised when there is a configuration error."""
    def __init__(self, message: str, setting_name: Optional[str] = None):
        self.setting_name = setting_name
        super().__init__(message)


class TwitchApiError(TwitchPluginError):
    """Raised when an API call fails."""
    def __init__(self, message: str, status_code: Optional[int] = None):
        self.status_code = status_code
        super().__init__(message)


# Utility functions
def normalize_channel(channel: str) -> str:
    """Normalize a Twitch channel name (ensure no # prefix)."""
    return channel.lstrip("#")


def format_channel_for_display(channel: str) -> str:
    """Format a channel name for display (with # prefix)."""
    normalized = normalize_channel(channel)
    return f"#{normalized}"


def get_twitch_user_display_name(user: TwitchUserInfo) -> str:
    """Get the best display name for a Twitch user."""
    return user.display_name or user.username


def strip_markdown_for_twitch(text: str) -> str:
    """Strip markdown formatting for Twitch chat display."""
    result = text
    # Remove bold
    result = re.sub(r"\*\*([^*]+)\*\*", r"\1", result)
    result = re.sub(r"__([^_]+)__", r"\1", result)
    # Remove italic
    result = re.sub(r"\*([^*]+)\*", r"\1", result)
    result = re.sub(r"_([^_]+)_", r"\1", result)
    # Remove strikethrough
    result = re.sub(r"~~([^~]+)~~", r"\1", result)
    # Remove inline code
    result = re.sub(r"`([^`]+)`", r"\1", result)
    # Remove code blocks
    result = re.sub(r"```[\s\S]*?```", "[code block]", result)
    # Remove links, keep text
    result = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", result)
    # Remove headers
    result = re.sub(r"^#{1,6}\s+", "", result, flags=re.MULTILINE)
    # Remove blockquotes
    result = re.sub(r"^>\s+", "", result, flags=re.MULTILINE)
    # Remove list markers
    result = re.sub(r"^[-*+]\s+", "• ", result, flags=re.MULTILINE)
    result = re.sub(r"^\d+\.\s+", "• ", result, flags=re.MULTILINE)
    # Collapse multiple newlines
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


def split_message_for_twitch(
    text: str,
    max_length: int = MAX_TWITCH_MESSAGE_LENGTH,
) -> list[str]:
    """Split a message into chunks that fit Twitch's message limit."""
    if len(text) <= max_length:
        return [text]

    chunks: list[str] = []
    remaining = text

    while remaining:
        if len(remaining) <= max_length:
            chunks.append(remaining)
            break

        # Try to split at a sentence boundary
        split_index = remaining.rfind(". ", 0, max_length)
        if split_index == -1 or split_index < max_length // 2:
            # Try to split at a word boundary
            split_index = remaining.rfind(" ", 0, max_length)
        if split_index == -1 or split_index < max_length // 2:
            # Force split at max length
            split_index = max_length

        chunks.append(remaining[:split_index].strip())
        remaining = remaining[split_index:].strip()

    return chunks
