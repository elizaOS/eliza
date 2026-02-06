"""
Type definitions for the Signal plugin.
"""

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

# Constants
MAX_SIGNAL_MESSAGE_LENGTH = 2000
MAX_SIGNAL_ATTACHMENT_SIZE = 100 * 1024 * 1024  # 100MB
SIGNAL_SERVICE_NAME = "signal"

# E.164 phone number regex
E164_PATTERN = re.compile(r"^\+[1-9]\d{1,14}$")

# UUID v4 regex
UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)

# Group ID is base64 encoded
GROUP_ID_PATTERN = re.compile(r"^[A-Za-z0-9+/]+=*$")


class SignalEventTypes(str, Enum):
    """Event types emitted by the Signal plugin."""
    MESSAGE_RECEIVED = "SIGNAL_MESSAGE_RECEIVED"
    MESSAGE_SENT = "SIGNAL_MESSAGE_SENT"
    REACTION_RECEIVED = "SIGNAL_REACTION_RECEIVED"
    GROUP_JOINED = "SIGNAL_GROUP_JOINED"
    GROUP_LEFT = "SIGNAL_GROUP_LEFT"
    TYPING_STARTED = "SIGNAL_TYPING_STARTED"
    TYPING_STOPPED = "SIGNAL_TYPING_STOPPED"
    CONTACT_UPDATED = "SIGNAL_CONTACT_UPDATED"


@dataclass
class SignalSettings:
    """Configuration settings for the Signal plugin."""
    account_number: str
    http_url: Optional[str] = None
    cli_path: Optional[str] = None
    should_ignore_group_messages: bool = False
    poll_interval_ms: int = 1000
    typing_indicator_enabled: bool = True


@dataclass
class SignalAttachment:
    """Represents a Signal message attachment."""
    content_type: str
    filename: Optional[str] = None
    id: Optional[str] = None
    size: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    voice_note: bool = False
    preview: Optional[str] = None


@dataclass
class SignalQuote:
    """Represents a quoted message in Signal."""
    id: int  # timestamp of quoted message
    author: str  # phone number of quoted message author
    text: Optional[str] = None
    attachments: list[SignalAttachment] = field(default_factory=list)


@dataclass
class SignalReactionInfo:
    """Information about a reaction on a Signal message."""
    emoji: str
    target_author: str
    target_sent_timestamp: int
    is_remove: bool = False


@dataclass
class SignalMessage:
    """Represents a Signal message."""
    timestamp: int
    source: str  # sender phone number
    source_uuid: Optional[str] = None
    source_device: Optional[int] = None
    text: Optional[str] = None
    attachments: list[SignalAttachment] = field(default_factory=list)
    group_id: Optional[str] = None
    quote: Optional[SignalQuote] = None
    reaction: Optional[SignalReactionInfo] = None
    expires_in_seconds: Optional[int] = None
    is_view_once: bool = False
    sticker: Optional[dict] = None


@dataclass
class SignalContact:
    """Represents a Signal contact."""
    number: str
    uuid: Optional[str] = None
    name: Optional[str] = None
    profile_name: Optional[str] = None
    given_name: Optional[str] = None
    family_name: Optional[str] = None
    color: Optional[str] = None
    blocked: bool = False
    message_expiration_time: int = 0


@dataclass
class SignalGroupMember:
    """Represents a member of a Signal group."""
    uuid: str
    number: Optional[str] = None
    role: str = "DEFAULT"  # "DEFAULT" or "ADMINISTRATOR"


@dataclass
class SignalGroup:
    """Represents a Signal group."""
    id: str
    name: str
    description: Optional[str] = None
    members: list[SignalGroupMember] = field(default_factory=list)
    pending_members: list[SignalGroupMember] = field(default_factory=list)
    requesting_members: list[SignalGroupMember] = field(default_factory=list)
    admins: list[SignalGroupMember] = field(default_factory=list)
    is_blocked: bool = False
    is_member: bool = True
    message_expiration_time: int = 0
    invite_link: Optional[str] = None


@dataclass
class SignalMessageSendOptions:
    """Options for sending a Signal message."""
    quote_timestamp: Optional[int] = None
    quote_author: Optional[str] = None
    attachments: list[str] = field(default_factory=list)  # file paths
    mentions: list[dict] = field(default_factory=list)
    text_style: Optional[list[dict]] = None
    preview_url: Optional[str] = None
    preview_title: Optional[str] = None


# Custom Exceptions
class SignalPluginError(Exception):
    """Base exception for Signal plugin errors."""
    pass


class SignalServiceNotInitializedError(SignalPluginError):
    """Raised when the Signal service is not initialized."""
    def __init__(self, message: str = "Signal service is not initialized"):
        super().__init__(message)


class SignalClientNotAvailableError(SignalPluginError):
    """Raised when the Signal client is not available."""
    def __init__(self, message: str = "Signal client is not available"):
        super().__init__(message)


class SignalConfigurationError(SignalPluginError):
    """Raised when there is a configuration error."""
    def __init__(self, message: str, setting_name: Optional[str] = None):
        self.setting_name = setting_name
        super().__init__(message)


class SignalApiError(SignalPluginError):
    """Raised when a Signal API call fails."""
    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        response_body: Optional[str] = None,
    ):
        self.status_code = status_code
        self.response_body = response_body
        super().__init__(message)


# Utility functions
def is_valid_e164(phone: str) -> bool:
    """Check if a string is a valid E.164 phone number."""
    return bool(E164_PATTERN.match(phone))


def normalize_e164(phone: str) -> Optional[str]:
    """
    Normalize a phone number to E.164 format.
    Returns None if the number cannot be normalized.
    """
    if not phone:
        return None
    
    # Remove whitespace and common separators
    cleaned = re.sub(r"[\s\-.()\[\]]", "", phone)
    
    # Add + if missing
    if not cleaned.startswith("+"):
        cleaned = "+" + cleaned
    
    # Validate
    if is_valid_e164(cleaned):
        return cleaned
    
    return None


def is_valid_uuid(uuid_str: str) -> bool:
    """Check if a string is a valid UUID v4."""
    return bool(UUID_PATTERN.match(uuid_str))


def is_valid_group_id(group_id: str) -> bool:
    """Check if a string appears to be a valid Signal group ID (base64)."""
    if not group_id or len(group_id) < 20:
        return False
    return bool(GROUP_ID_PATTERN.match(group_id))


def get_signal_contact_display_name(contact: SignalContact) -> str:
    """Get the best display name for a Signal contact."""
    if contact.name:
        return contact.name
    if contact.profile_name:
        return contact.profile_name
    if contact.given_name:
        if contact.family_name:
            return f"{contact.given_name} {contact.family_name}"
        return contact.given_name
    return contact.number
