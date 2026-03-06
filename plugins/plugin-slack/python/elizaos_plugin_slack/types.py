"""
Type definitions for the elizaOS Slack plugin.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, List, Dict, Any
import re


class SlackEventTypes(str, Enum):
    """Slack-specific event types."""
    MESSAGE_RECEIVED = "SLACK_MESSAGE_RECEIVED"
    MESSAGE_SENT = "SLACK_MESSAGE_SENT"
    REACTION_ADDED = "SLACK_REACTION_ADDED"
    REACTION_REMOVED = "SLACK_REACTION_REMOVED"
    CHANNEL_JOINED = "SLACK_CHANNEL_JOINED"
    CHANNEL_LEFT = "SLACK_CHANNEL_LEFT"
    MEMBER_JOINED_CHANNEL = "SLACK_MEMBER_JOINED_CHANNEL"
    MEMBER_LEFT_CHANNEL = "SLACK_MEMBER_LEFT_CHANNEL"
    APP_MENTION = "SLACK_APP_MENTION"
    SLASH_COMMAND = "SLACK_SLASH_COMMAND"
    FILE_SHARED = "SLACK_FILE_SHARED"
    THREAD_REPLY = "SLACK_THREAD_REPLY"


@dataclass
class SlackUserProfile:
    """Slack user profile information."""
    title: Optional[str] = None
    phone: Optional[str] = None
    skype: Optional[str] = None
    real_name: Optional[str] = None
    real_name_normalized: Optional[str] = None
    display_name: Optional[str] = None
    display_name_normalized: Optional[str] = None
    status_text: Optional[str] = None
    status_emoji: Optional[str] = None
    status_expiration: Optional[int] = None
    avatar_hash: Optional[str] = None
    email: Optional[str] = None
    image_24: Optional[str] = None
    image_32: Optional[str] = None
    image_48: Optional[str] = None
    image_72: Optional[str] = None
    image_192: Optional[str] = None
    image_512: Optional[str] = None
    image_1024: Optional[str] = None
    image_original: Optional[str] = None
    team: Optional[str] = None


@dataclass
class SlackUser:
    """Slack user information."""
    id: str
    name: str
    profile: SlackUserProfile
    team_id: Optional[str] = None
    deleted: bool = False
    real_name: Optional[str] = None
    tz: Optional[str] = None
    tz_label: Optional[str] = None
    tz_offset: Optional[int] = None
    is_admin: bool = False
    is_owner: bool = False
    is_primary_owner: bool = False
    is_restricted: bool = False
    is_ultra_restricted: bool = False
    is_bot: bool = False
    is_app_user: bool = False
    updated: int = 0


@dataclass
class SlackChannelTopic:
    """Slack channel topic."""
    value: str
    creator: str
    last_set: int


@dataclass
class SlackChannelPurpose:
    """Slack channel purpose."""
    value: str
    creator: str
    last_set: int


@dataclass
class SlackChannel:
    """Slack channel information."""
    id: str
    name: str
    created: int
    creator: str
    is_channel: bool = False
    is_group: bool = False
    is_im: bool = False
    is_mpim: bool = False
    is_private: bool = False
    is_archived: bool = False
    is_general: bool = False
    is_shared: bool = False
    is_org_shared: bool = False
    is_member: bool = False
    topic: Optional[SlackChannelTopic] = None
    purpose: Optional[SlackChannelPurpose] = None
    num_members: Optional[int] = None


@dataclass
class SlackFile:
    """Slack file information."""
    id: str
    name: str
    title: str
    mimetype: str
    filetype: str
    size: int
    url_private: str
    url_private_download: Optional[str] = None
    permalink: str = ""
    thumb_64: Optional[str] = None
    thumb_80: Optional[str] = None
    thumb_360: Optional[str] = None


@dataclass
class SlackReaction:
    """Slack reaction information."""
    name: str
    count: int
    users: List[str] = field(default_factory=list)


@dataclass
class SlackMessage:
    """Slack message information."""
    type: str
    ts: str
    text: str
    subtype: Optional[str] = None
    user: Optional[str] = None
    thread_ts: Optional[str] = None
    reply_count: Optional[int] = None
    reply_users_count: Optional[int] = None
    latest_reply: Optional[str] = None
    reactions: Optional[List[SlackReaction]] = None
    files: Optional[List[SlackFile]] = None
    attachments: Optional[List[Dict[str, Any]]] = None
    blocks: Optional[List[Dict[str, Any]]] = None


@dataclass
class SlackSettings:
    """Slack plugin settings."""
    allowed_channel_ids: Optional[List[str]] = None
    should_ignore_bot_messages: bool = False
    should_respond_only_to_mentions: bool = False


class SlackPluginError(Exception):
    """Base exception for Slack plugin errors."""
    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.code = code


class SlackServiceNotInitializedError(SlackPluginError):
    """Raised when the Slack service is not initialized."""
    def __init__(self):
        super().__init__("Slack service is not initialized", "SERVICE_NOT_INITIALIZED")


class SlackClientNotAvailableError(SlackPluginError):
    """Raised when the Slack client is not available."""
    def __init__(self):
        super().__init__("Slack client is not available", "CLIENT_NOT_AVAILABLE")


class SlackConfigurationError(SlackPluginError):
    """Raised when required configuration is missing."""
    def __init__(self, missing_config: str):
        super().__init__(f"Missing required configuration: {missing_config}", "MISSING_CONFIG")


class SlackApiError(SlackPluginError):
    """Raised when a Slack API error occurs."""
    def __init__(self, message: str, api_error_code: Optional[str] = None):
        super().__init__(message, "API_ERROR")
        self.api_error_code = api_error_code


# Validation functions

def is_valid_channel_id(id: str) -> bool:
    """Validate a Slack channel ID format."""
    return bool(re.match(r'^[CGD][A-Z0-9]{8,}$', id, re.IGNORECASE))


def is_valid_user_id(id: str) -> bool:
    """Validate a Slack user ID format."""
    return bool(re.match(r'^[UW][A-Z0-9]{8,}$', id, re.IGNORECASE))


def is_valid_team_id(id: str) -> bool:
    """Validate a Slack team ID format."""
    return bool(re.match(r'^T[A-Z0-9]{8,}$', id, re.IGNORECASE))


def is_valid_message_ts(ts: str) -> bool:
    """Validate a Slack message timestamp format."""
    return bool(re.match(r'^\d+\.\d{6}$', ts))


def get_slack_user_display_name(user: SlackUser) -> str:
    """Get the display name for a Slack user."""
    return (
        user.profile.display_name or
        user.profile.real_name or
        user.name
    )


def get_slack_channel_type(channel: SlackChannel) -> str:
    """Determine the channel type from a Slack channel object."""
    if channel.is_im:
        return "im"
    if channel.is_mpim:
        return "mpim"
    if channel.is_group or channel.is_private:
        return "group"
    return "channel"


# Constants
SLACK_SERVICE_NAME = "slack"
MAX_SLACK_MESSAGE_LENGTH = 4000
MAX_SLACK_BLOCKS = 50
MAX_SLACK_FILE_SIZE = 1024 * 1024 * 1024  # 1GB
