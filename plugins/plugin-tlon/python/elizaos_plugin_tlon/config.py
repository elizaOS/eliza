"""Configuration for the Tlon plugin."""

from __future__ import annotations

import json
import os

from pydantic import BaseModel, Field


def normalize_ship(ship: str) -> str:
    """Remove ~ prefix from ship name if present."""
    return ship.lstrip("~")


def format_ship(ship: str) -> str:
    """Format ship name with ~ prefix."""
    return f"~{normalize_ship(ship)}"


def parse_channel_nest(nest: str) -> tuple[str, str, str] | None:
    """Parse a channel nest string (e.g., 'chat/~host/channel-name').

    Returns (kind, host_ship, channel_name) or None if invalid.
    """
    parts = nest.split("/")
    if len(parts) != 3:
        return None

    kind, host_ship, channel_name = parts
    if not kind or not host_ship or not channel_name:
        return None

    return kind, normalize_ship(host_ship), channel_name


def build_channel_nest(kind: str, host_ship: str, channel_name: str) -> str:
    """Build a channel nest string from components."""
    return f"{kind}/{format_ship(host_ship)}/{channel_name}"


class TlonConfig(BaseModel):
    """Configuration for the Tlon plugin."""

    ship: str
    url: str
    code: str
    enabled: bool = True
    group_channels: list[str] = Field(default_factory=list)
    dm_allowlist: list[str] = Field(default_factory=list)
    auto_discover_channels: bool = True

    def model_post_init(self, __context: object) -> None:
        """Normalize values after initialization."""
        self.ship = normalize_ship(self.ship)
        self.url = self.url.rstrip("/")
        self.dm_allowlist = [normalize_ship(s) for s in self.dm_allowlist]

    @classmethod
    def from_env(cls) -> TlonConfig:
        """Load configuration from environment variables.

        Required:
            - TLON_SHIP
            - TLON_URL
            - TLON_CODE

        Optional:
            - TLON_ENABLED (default: true)
            - TLON_GROUP_CHANNELS (JSON array)
            - TLON_DM_ALLOWLIST (JSON array)
            - TLON_AUTO_DISCOVER_CHANNELS (default: true)
        """
        ship = os.getenv("TLON_SHIP")
        if not ship:
            raise ValueError("TLON_SHIP environment variable is required")

        url = os.getenv("TLON_URL")
        if not url:
            raise ValueError("TLON_URL environment variable is required")

        code = os.getenv("TLON_CODE")
        if not code:
            raise ValueError("TLON_CODE environment variable is required")

        enabled = os.getenv("TLON_ENABLED", "true").lower() == "true"

        group_channels_str = os.getenv("TLON_GROUP_CHANNELS", "[]")
        try:
            group_channels = json.loads(group_channels_str)
            if not isinstance(group_channels, list):
                group_channels = []
        except json.JSONDecodeError:
            group_channels = []

        dm_allowlist_str = os.getenv("TLON_DM_ALLOWLIST", "[]")
        try:
            dm_allowlist = json.loads(dm_allowlist_str)
            if not isinstance(dm_allowlist, list):
                dm_allowlist = []
        except json.JSONDecodeError:
            dm_allowlist = []

        auto_discover = os.getenv("TLON_AUTO_DISCOVER_CHANNELS", "true").lower() == "true"

        return cls(
            ship=ship,
            url=url,
            code=code,
            enabled=enabled,
            group_channels=group_channels,
            dm_allowlist=dm_allowlist,
            auto_discover_channels=auto_discover,
        )

    def is_dm_allowed(self, ship: str) -> bool:
        """Check if a ship is allowed to send DMs."""
        if not self.dm_allowlist:
            return True
        normalized = normalize_ship(ship)
        return normalized in self.dm_allowlist

    def formatted_ship(self) -> str:
        """Get the ship name with ~ prefix."""
        return format_ship(self.ship)
