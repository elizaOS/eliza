"""
Configuration for the Farcaster plugin.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

from elizaos_plugin_farcaster.error import ConfigError
from elizaos_plugin_farcaster.types import (
    DEFAULT_CAST_INTERVAL_MAX,
    DEFAULT_CAST_INTERVAL_MIN,
    DEFAULT_MAX_CAST_LENGTH,
    DEFAULT_POLL_INTERVAL,
)


@dataclass
class FarcasterConfig:
    """Configuration for the Farcaster client."""

    # Required settings
    fid: int
    """Farcaster ID (FID) for the account."""

    signer_uuid: str
    """Neynar signer UUID for signing casts."""

    neynar_api_key: str
    """Neynar API key for API access."""

    # Optional settings
    dry_run: bool = False
    """Enable dry run mode (operations are simulated but not executed)."""

    mode: Literal["polling", "webhook"] = "polling"
    """Operation mode: 'polling' or 'webhook'."""

    max_cast_length: int = DEFAULT_MAX_CAST_LENGTH
    """Maximum cast length in characters."""

    poll_interval: int = DEFAULT_POLL_INTERVAL
    """Polling interval in seconds."""

    enable_cast: bool = True
    """Enable auto-casting."""

    cast_interval_min: int = DEFAULT_CAST_INTERVAL_MIN
    """Minimum interval between casts in minutes."""

    cast_interval_max: int = DEFAULT_CAST_INTERVAL_MAX
    """Maximum interval between casts in minutes."""

    enable_action_processing: bool = True
    """Enable action processing for Farcaster events."""

    action_interval: int = 1000
    """Interval between action processing cycles in milliseconds."""

    cast_immediately: bool = True
    """Post casts immediately instead of waiting for schedule."""

    max_actions_processing: int = 10
    """Maximum number of actions to process in a batch."""

    hub_url: str | None = None
    """Optional custom Farcaster hub URL."""

    @classmethod
    def from_env(cls) -> FarcasterConfig:
        """
        Create configuration from environment variables.

        Required environment variables:
        - FARCASTER_FID: Farcaster ID
        - FARCASTER_SIGNER_UUID: Neynar signer UUID
        - FARCASTER_NEYNAR_API_KEY: Neynar API key

        Optional environment variables:
        - FARCASTER_DRY_RUN: Enable dry run mode
        - FARCASTER_MODE: 'polling' or 'webhook'
        - MAX_CAST_LENGTH: Maximum cast length
        - FARCASTER_POLL_INTERVAL: Polling interval in seconds
        - ENABLE_CAST: Enable auto-casting
        - CAST_INTERVAL_MIN: Min cast interval in minutes
        - CAST_INTERVAL_MAX: Max cast interval in minutes
        - FARCASTER_HUB_URL: Custom hub URL

        Raises:
            ConfigError: If required environment variables are missing.
        """
        # Required settings
        fid_str = os.getenv("FARCASTER_FID")
        if not fid_str:
            raise ConfigError("FARCASTER_FID environment variable is required")
        try:
            fid = int(fid_str)
        except ValueError as e:
            raise ConfigError(f"FARCASTER_FID must be an integer: {e}") from e

        signer_uuid = os.getenv("FARCASTER_SIGNER_UUID")
        if not signer_uuid:
            raise ConfigError("FARCASTER_SIGNER_UUID environment variable is required")

        neynar_api_key = os.getenv("FARCASTER_NEYNAR_API_KEY")
        if not neynar_api_key:
            raise ConfigError("FARCASTER_NEYNAR_API_KEY environment variable is required")

        # Optional settings
        dry_run = os.getenv("FARCASTER_DRY_RUN", "false").lower() == "true"

        mode_str = os.getenv("FARCASTER_MODE", "polling")
        mode: Literal["polling", "webhook"] = (
            "webhook" if mode_str.lower() == "webhook" else "polling"
        )

        max_cast_length = int(os.getenv("MAX_CAST_LENGTH", str(DEFAULT_MAX_CAST_LENGTH)))
        poll_interval = int(os.getenv("FARCASTER_POLL_INTERVAL", str(DEFAULT_POLL_INTERVAL)))
        enable_cast = os.getenv("ENABLE_CAST", "true").lower() == "true"
        cast_interval_min = int(os.getenv("CAST_INTERVAL_MIN", str(DEFAULT_CAST_INTERVAL_MIN)))
        cast_interval_max = int(os.getenv("CAST_INTERVAL_MAX", str(DEFAULT_CAST_INTERVAL_MAX)))
        hub_url = os.getenv("FARCASTER_HUB_URL")

        return cls(
            fid=fid,
            signer_uuid=signer_uuid,
            neynar_api_key=neynar_api_key,
            dry_run=dry_run,
            mode=mode,
            max_cast_length=max_cast_length,
            poll_interval=poll_interval,
            enable_cast=enable_cast,
            cast_interval_min=cast_interval_min,
            cast_interval_max=cast_interval_max,
            hub_url=hub_url,
        )

    def validate(self) -> None:
        """
        Validate the configuration.

        Raises:
            ConfigError: If configuration is invalid.
        """
        if self.fid < 1:
            raise ConfigError("FARCASTER_FID must be a positive integer")
        if not self.signer_uuid:
            raise ConfigError("FARCASTER_SIGNER_UUID is required")
        if not self.neynar_api_key:
            raise ConfigError("FARCASTER_NEYNAR_API_KEY is required")
        if self.max_cast_length < 1 or self.max_cast_length > 1024:
            raise ConfigError("MAX_CAST_LENGTH must be between 1 and 1024")
        if self.poll_interval < 1:
            raise ConfigError("FARCASTER_POLL_INTERVAL must be a positive integer")
        if self.cast_interval_min < 0:
            raise ConfigError("CAST_INTERVAL_MIN must be non-negative")
        if self.cast_interval_max < self.cast_interval_min:
            raise ConfigError("CAST_INTERVAL_MAX must be >= CAST_INTERVAL_MIN")
