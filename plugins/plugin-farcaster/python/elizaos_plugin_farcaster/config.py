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
    fid: int
    signer_uuid: str
    neynar_api_key: str
    dry_run: bool = False
    mode: Literal["polling", "webhook"] = "polling"
    max_cast_length: int = DEFAULT_MAX_CAST_LENGTH
    poll_interval: int = DEFAULT_POLL_INTERVAL
    enable_cast: bool = True
    cast_interval_min: int = DEFAULT_CAST_INTERVAL_MIN
    cast_interval_max: int = DEFAULT_CAST_INTERVAL_MAX
    enable_action_processing: bool = True
    action_interval: int = 1000
    cast_immediately: bool = True
    max_actions_processing: int = 10
    hub_url: str | None = None

    @classmethod
    def from_env(cls) -> FarcasterConfig:
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
