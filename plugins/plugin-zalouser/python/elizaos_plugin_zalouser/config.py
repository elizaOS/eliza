"""Configuration for the Zalo User plugin."""

import json
import os
from typing import Literal

from pydantic import BaseModel, Field

# Constants
DEFAULT_PROFILE = "default"
DEFAULT_TIMEOUT_MS = 30000
MAX_MESSAGE_LENGTH = 2000
ZCA_BINARY = "zca"

DmPolicy = Literal["open", "allowlist", "pairing", "disabled"]
GroupPolicy = Literal["open", "allowlist", "disabled"]


class ZaloUserConfig(BaseModel):
    """Configuration for the Zalo User plugin."""

    cookie_path: str | None = None
    imei: str | None = None
    user_agent: str | None = None
    enabled: bool = True
    default_profile: str = Field(default=DEFAULT_PROFILE)
    listen_timeout: int = Field(default=DEFAULT_TIMEOUT_MS)
    allowed_threads: list[str] = Field(default_factory=list)
    dm_policy: DmPolicy = Field(default="pairing")
    group_policy: GroupPolicy = Field(default="disabled")

    @classmethod
    def from_env(cls) -> "ZaloUserConfig":
        """Load configuration from environment variables."""
        cookie_path = os.getenv("ZALOUSER_COOKIE_PATH")
        imei = os.getenv("ZALOUSER_IMEI")
        user_agent = os.getenv("ZALOUSER_USER_AGENT")
        enabled = os.getenv("ZALOUSER_ENABLED", "true").lower() not in ("false", "0")
        default_profile = os.getenv("ZALOUSER_DEFAULT_PROFILE", DEFAULT_PROFILE)
        
        listen_timeout_str = os.getenv("ZALOUSER_LISTEN_TIMEOUT")
        listen_timeout = int(listen_timeout_str) if listen_timeout_str else DEFAULT_TIMEOUT_MS
        
        allowed_threads = _parse_allowed_threads(os.getenv("ZALOUSER_ALLOWED_THREADS"))
        
        dm_policy_str = os.getenv("ZALOUSER_DM_POLICY", "pairing")
        dm_policy: DmPolicy = dm_policy_str if dm_policy_str in ("open", "allowlist", "pairing", "disabled") else "pairing"  # type: ignore[assignment]
        
        group_policy_str = os.getenv("ZALOUSER_GROUP_POLICY", "disabled")
        group_policy: GroupPolicy = group_policy_str if group_policy_str in ("open", "allowlist", "disabled") else "disabled"  # type: ignore[assignment]

        return cls(
            cookie_path=cookie_path,
            imei=imei,
            user_agent=user_agent,
            enabled=enabled,
            default_profile=default_profile,
            listen_timeout=listen_timeout,
            allowed_threads=allowed_threads,
            dm_policy=dm_policy,
            group_policy=group_policy,
        )

    def is_thread_allowed(self, thread_id: str) -> bool:
        """Check if a thread is allowed."""
        if not self.allowed_threads:
            return True
        return thread_id in self.allowed_threads

    def validate_config(self) -> None:
        """Validate the configuration."""
        if not self.enabled:
            raise ValueError("Plugin is disabled")

        valid_dm_policies = ("open", "allowlist", "pairing", "disabled")
        if self.dm_policy not in valid_dm_policies:
            raise ValueError(
                f"Invalid DM policy: {self.dm_policy}. Must be one of: {valid_dm_policies}"
            )

        valid_group_policies = ("open", "allowlist", "disabled")
        if self.group_policy not in valid_group_policies:
            raise ValueError(
                f"Invalid group policy: {self.group_policy}. Must be one of: {valid_group_policies}"
            )


def _parse_allowed_threads(value: str | None) -> list[str]:
    """Parse allowed threads from JSON array or comma-separated string."""
    if not value:
        return []

    trimmed = value.strip()
    if not trimmed:
        return []

    # Try parsing as JSON array
    if trimmed.startswith("["):
        try:
            parsed = json.loads(trimmed)
            if isinstance(parsed, list):
                return [str(item) for item in parsed if item]
        except json.JSONDecodeError:
            pass

    # Parse as comma-separated
    return [s.strip() for s in trimmed.split(",") if s.strip()]
