"""
Type definitions for the Matrix plugin.
"""

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

# Constants
MAX_MATRIX_MESSAGE_LENGTH = 4000
MATRIX_SERVICE_NAME = "matrix"

# Regex patterns
USER_ID_PATTERN = re.compile(r"^@[^:]+:.+$")
ROOM_ID_PATTERN = re.compile(r"^![^:]+:.+$")
ROOM_ALIAS_PATTERN = re.compile(r"^#[^:]+:.+$")


class MatrixEventTypes(str, Enum):
    """Event types emitted by the Matrix plugin."""
    MESSAGE_RECEIVED = "MATRIX_MESSAGE_RECEIVED"
    MESSAGE_SENT = "MATRIX_MESSAGE_SENT"
    ROOM_JOINED = "MATRIX_ROOM_JOINED"
    ROOM_LEFT = "MATRIX_ROOM_LEFT"
    INVITE_RECEIVED = "MATRIX_INVITE_RECEIVED"
    REACTION_RECEIVED = "MATRIX_REACTION_RECEIVED"
    TYPING_RECEIVED = "MATRIX_TYPING_RECEIVED"
    SYNC_COMPLETE = "MATRIX_SYNC_COMPLETE"
    CONNECTION_READY = "MATRIX_CONNECTION_READY"
    CONNECTION_LOST = "MATRIX_CONNECTION_LOST"


@dataclass
class MatrixSettings:
    """Configuration settings for the Matrix plugin."""
    homeserver: str
    user_id: str
    access_token: str
    device_id: Optional[str] = None
    rooms: list[str] = field(default_factory=list)
    auto_join: bool = False
    encryption: bool = False
    require_mention: bool = False
    enabled: bool = True


@dataclass
class MatrixUserInfo:
    """Information about a Matrix user."""
    user_id: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None


@dataclass
class MatrixRoom:
    """Represents a Matrix room."""
    room_id: str
    name: Optional[str] = None
    topic: Optional[str] = None
    canonical_alias: Optional[str] = None
    is_encrypted: bool = False
    is_direct: bool = False
    member_count: int = 0


@dataclass
class MatrixMessage:
    """Represents a Matrix message."""
    event_id: str
    room_id: str
    sender: str
    sender_info: MatrixUserInfo
    content: str
    msg_type: str
    formatted_body: Optional[str] = None
    timestamp: int = 0
    thread_id: Optional[str] = None
    reply_to: Optional[str] = None
    is_edit: bool = False
    replaces_event_id: Optional[str] = None


@dataclass
class MatrixMessageSendOptions:
    """Options for sending a message."""
    room_id: Optional[str] = None
    reply_to: Optional[str] = None
    thread_id: Optional[str] = None
    formatted: bool = False
    media_url: Optional[str] = None


@dataclass
class MatrixSendResult:
    """Result from sending a message."""
    success: bool
    event_id: Optional[str] = None
    room_id: Optional[str] = None
    error: Optional[str] = None


# Custom Exceptions
class MatrixPluginError(Exception):
    """Base exception for Matrix plugin errors."""
    pass


class MatrixServiceNotInitializedError(MatrixPluginError):
    """Raised when the Matrix service is not initialized."""
    def __init__(self, message: str = "Matrix service is not initialized"):
        super().__init__(message)


class MatrixNotConnectedError(MatrixPluginError):
    """Raised when the Matrix client is not connected."""
    def __init__(self, message: str = "Matrix client is not connected"):
        super().__init__(message)


class MatrixConfigurationError(MatrixPluginError):
    """Raised when there is a configuration error."""
    def __init__(self, message: str, setting_name: Optional[str] = None):
        self.setting_name = setting_name
        super().__init__(message)


class MatrixApiError(MatrixPluginError):
    """Raised when an API call fails."""
    def __init__(self, message: str, errcode: Optional[str] = None):
        self.errcode = errcode
        super().__init__(message)


# Utility functions
def is_valid_matrix_user_id(user_id: str) -> bool:
    """Check if a string is a valid Matrix user ID."""
    return bool(USER_ID_PATTERN.match(user_id))


def is_valid_matrix_room_id(room_id: str) -> bool:
    """Check if a string is a valid Matrix room ID."""
    return bool(ROOM_ID_PATTERN.match(room_id))


def is_valid_matrix_room_alias(alias: str) -> bool:
    """Check if a string is a valid Matrix room alias."""
    return bool(ROOM_ALIAS_PATTERN.match(alias))


def get_matrix_localpart(matrix_id: str) -> str:
    """Extract the localpart from a Matrix ID."""
    match = re.match(r"^[@#!]([^:]+):", matrix_id)
    return match.group(1) if match else matrix_id


def get_matrix_serverpart(matrix_id: str) -> str:
    """Extract the server part from a Matrix ID."""
    match = re.search(r":(.+)$", matrix_id)
    return match.group(1) if match else ""


def get_matrix_user_display_name(user: MatrixUserInfo) -> str:
    """Get the best display name for a Matrix user."""
    return user.display_name or get_matrix_localpart(user.user_id)


def matrix_mxc_to_http(mxc_url: str, homeserver: str) -> Optional[str]:
    """Convert a media URL to an HTTP URL via homeserver."""
    if not mxc_url.startswith("mxc://"):
        return None
    
    parts = mxc_url[6:].split("/")
    if len(parts) < 2:
        return None
    
    server_name, media_id = parts[0], parts[1]
    base = homeserver.rstrip("/")
    return f"{base}/_matrix/media/v3/download/{server_name}/{media_id}"
