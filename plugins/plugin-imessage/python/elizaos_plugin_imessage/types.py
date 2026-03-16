"""
Type definitions for the iMessage plugin.
"""

import re
import sys
from dataclasses import dataclass, field

# Constants
MAX_IMESSAGE_MESSAGE_LENGTH = 4000
DEFAULT_POLL_INTERVAL_MS = 5000
IMESSAGE_SERVICE_NAME = "imessage"

# Regex patterns
PHONE_PATTERN = re.compile(r"^\+?\d{10,15}$")
EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class IMessageEventTypes:
    """Event types emitted by the iMessage plugin."""

    MESSAGE_RECEIVED = "IMESSAGE_MESSAGE_RECEIVED"
    MESSAGE_SENT = "IMESSAGE_MESSAGE_SENT"
    CONNECTION_READY = "IMESSAGE_CONNECTION_READY"
    ERROR = "IMESSAGE_ERROR"


@dataclass
class IMessageSettings:
    """Configuration settings for the iMessage plugin."""

    cli_path: str = "imsg"
    db_path: str | None = None
    poll_interval_ms: int = DEFAULT_POLL_INTERVAL_MS
    dm_policy: str = "pairing"  # open, pairing, allowlist, disabled
    group_policy: str = "allowlist"  # open, allowlist, disabled
    allow_from: list[str] = field(default_factory=list)
    enabled: bool = True


@dataclass
class IMessageContact:
    """iMessage contact."""

    handle: str
    display_name: str | None = None
    is_phone_number: bool = False


@dataclass
class IMessageChat:
    """iMessage chat."""

    chat_id: str
    chat_type: str  # "direct" or "group"
    display_name: str | None = None
    participants: list[IMessageContact] = field(default_factory=list)


@dataclass
class IMessageMessage:
    """iMessage message."""

    id: str
    text: str
    handle: str
    chat_id: str
    timestamp: int
    is_from_me: bool = False
    has_attachments: bool = False
    attachment_paths: list[str] = field(default_factory=list)


@dataclass
class IMessageSendResult:
    """Result from sending a message."""

    success: bool
    message_id: str | None = None
    chat_id: str | None = None
    error: str | None = None


class IMessagePluginError(Exception):
    """Base error for iMessage plugin."""

    def __init__(self, message: str, code: str = "PLUGIN_ERROR", details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


class IMessageConfigurationError(IMessagePluginError):
    """Configuration error."""

    def __init__(self, message: str, setting: str | None = None):
        super().__init__(
            message,
            "CONFIGURATION_ERROR",
            {"setting": setting} if setting else None,
        )


class IMessageNotSupportedError(IMessagePluginError):
    """Platform not supported error."""

    def __init__(self, message: str = "iMessage is only supported on macOS"):
        super().__init__(message, "NOT_SUPPORTED")


class IMessageCliError(IMessagePluginError):
    """CLI error."""

    def __init__(self, message: str, exit_code: int | None = None):
        super().__init__(
            message,
            "CLI_ERROR",
            {"exit_code": exit_code} if exit_code is not None else None,
        )


# Utility functions


def is_phone_number(input_str: str) -> bool:
    """Check if a string looks like a phone number."""
    # Remove common formatting
    cleaned = re.sub(r"[\s\-\(\)\.]", "", input_str)
    return bool(PHONE_PATTERN.match(cleaned))


def is_email(input_str: str) -> bool:
    """Check if a string looks like an email."""
    return bool(EMAIL_PATTERN.match(input_str))


def is_valid_imessage_target(target: str) -> bool:
    """Check if a string is a valid iMessage target (phone or email)."""
    trimmed = target.strip()
    return is_phone_number(trimmed) or is_email(trimmed) or trimmed.startswith("chat_id:")


def normalize_imessage_target(target: str) -> str | None:
    """Normalize an iMessage target."""
    trimmed = target.strip()
    if not trimmed:
        return None

    # Handle chat_id: prefix
    if trimmed.startswith("chat_id:"):
        return trimmed

    # Handle imessage: prefix
    if trimmed.lower().startswith("imessage:"):
        return trimmed[9:].strip()

    # Return as-is for phone numbers and emails
    return trimmed


def format_phone_number(phone: str) -> str:
    """Format a phone number for iMessage."""
    # Remove formatting
    cleaned = re.sub(r"[\s\-\(\)\.]", "", phone)

    # Add + prefix if missing for international
    if len(cleaned) > 10 and not cleaned.startswith("+"):
        cleaned = "+" + cleaned

    return cleaned


def split_message_for_imessage(
    text: str, max_length: int = MAX_IMESSAGE_MESSAGE_LENGTH
) -> list[str]:
    """Split text for iMessage."""
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


def is_macos() -> bool:
    """Check if running on macOS."""
    return sys.platform == "darwin"
