import json
import os
from typing import Any

from pydantic import BaseModel, Field

from elizaos_plugin_mattermost.types import DmPolicy, GroupPolicy


def normalize_server_url(url: str) -> str:
    """Normalizes the server URL by removing trailing slashes and /api/v4 suffix."""
    trimmed = url.strip()
    if not trimmed:
        return ""
    # Remove trailing slashes
    normalized = trimmed.rstrip("/")
    # Remove /api/v4 suffix if present
    if normalized.lower().endswith("/api/v4"):
        normalized = normalized[:-7]
    return normalized


class MattermostConfig(BaseModel):
    """Configuration options for the Mattermost plugin."""

    server_url: str
    bot_token: str
    team_id: str | None = None
    enabled: bool = True
    dm_policy: DmPolicy = DmPolicy.PAIRING
    group_policy: GroupPolicy = GroupPolicy.ALLOWLIST
    allowed_users: list[str] = Field(default_factory=list)
    allowed_channels: list[str] = Field(default_factory=list)
    require_mention: bool = True
    ignore_bot_messages: bool = True

    @classmethod
    def from_env(cls) -> "MattermostConfig":
        """Loads configuration from environment variables."""
        server_url = os.getenv("MATTERMOST_SERVER_URL")
        if not server_url:
            raise ValueError("MATTERMOST_SERVER_URL environment variable is required")

        bot_token = os.getenv("MATTERMOST_BOT_TOKEN")
        if not bot_token:
            raise ValueError("MATTERMOST_BOT_TOKEN environment variable is required")

        team_id = os.getenv("MATTERMOST_TEAM_ID")

        enabled_str = os.getenv("MATTERMOST_ENABLED", "true")
        enabled = enabled_str.lower() == "true"

        dm_policy_str = os.getenv("MATTERMOST_DM_POLICY", "pairing").lower()
        dm_policy = DmPolicy(dm_policy_str) if dm_policy_str in [p.value for p in DmPolicy] else DmPolicy.PAIRING

        group_policy_str = os.getenv("MATTERMOST_GROUP_POLICY", "allowlist").lower()
        group_policy = GroupPolicy(group_policy_str) if group_policy_str in [p.value for p in GroupPolicy] else GroupPolicy.ALLOWLIST

        allowed_users = _parse_json_list(os.getenv("MATTERMOST_ALLOWED_USERS", "[]"))
        allowed_channels = _parse_json_list(os.getenv("MATTERMOST_ALLOWED_CHANNELS", "[]"))

        require_mention_str = os.getenv("MATTERMOST_REQUIRE_MENTION", "true")
        require_mention = require_mention_str.lower() == "true"

        ignore_bot_str = os.getenv("MATTERMOST_IGNORE_BOT_MESSAGES", "true")
        ignore_bot_messages = ignore_bot_str.lower() == "true"

        return cls(
            server_url=normalize_server_url(server_url),
            bot_token=bot_token,
            team_id=team_id,
            enabled=enabled,
            dm_policy=dm_policy,
            group_policy=group_policy,
            allowed_users=allowed_users,
            allowed_channels=allowed_channels,
            require_mention=require_mention,
            ignore_bot_messages=ignore_bot_messages,
        )

    def is_user_allowed(self, user_id: str, username: str | None = None) -> bool:
        """Returns True if the given user is allowed."""
        if not self.allowed_users:
            return True

        allowed_lower = [u.lower() for u in self.allowed_users]

        if "*" in allowed_lower:
            return True

        if user_id.lower() in allowed_lower:
            return True

        if username and username.lower() in allowed_lower:
            return True

        return False

    def is_channel_allowed(self, channel_id: str) -> bool:
        """Returns True if the given channel is allowed."""
        if not self.allowed_channels:
            return True
        return channel_id in self.allowed_channels

    @property
    def api_base_url(self) -> str:
        """Returns the API base URL."""
        return f"{self.server_url}/api/v4"


def _parse_json_list(value: str) -> list[str]:
    """Parse a JSON array string into a list of strings."""
    if not value:
        return []
    trimmed = value.strip()
    if not trimmed:
        return []
    try:
        parsed = json.loads(trimmed)
        if isinstance(parsed, list):
            return [str(item) for item in parsed]
    except json.JSONDecodeError:
        pass
    return []
