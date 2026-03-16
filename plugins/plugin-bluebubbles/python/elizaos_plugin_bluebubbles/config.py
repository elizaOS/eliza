"""Configuration for the BlueBubbles plugin."""

import os
import re
from typing import Self

from pydantic import BaseModel, Field, model_validator

from elizaos_plugin_bluebubbles.types import DmPolicy, GroupPolicy

DEFAULT_WEBHOOK_PATH = "/webhooks/bluebubbles"


class BlueBubblesConfig(BaseModel):
    """BlueBubbles plugin configuration."""

    server_url: str = Field(description="BlueBubbles server URL")
    password: str = Field(description="Server password")
    webhook_path: str = Field(
        default=DEFAULT_WEBHOOK_PATH, description="Webhook path for receiving messages"
    )
    dm_policy: DmPolicy = Field(default=DmPolicy.PAIRING, description="DM policy")
    group_policy: GroupPolicy = Field(default=GroupPolicy.ALLOWLIST, description="Group policy")
    allow_from: list[str] = Field(default_factory=list, description="Allow list for DMs")
    group_allow_from: list[str] = Field(
        default_factory=list, description="Allow list for groups"
    )
    send_read_receipts: bool = Field(default=True, description="Send read receipts")
    enabled: bool = Field(default=True, description="Whether the plugin is enabled")

    @model_validator(mode="after")
    def validate_config(self) -> Self:
        """Validates the configuration."""
        if not self.server_url:
            raise ValueError("Server URL is required")
        if not self.password:
            raise ValueError("Password is required")

        # Validate URL format
        if not self.server_url.startswith(("http://", "https://")):
            raise ValueError("Server URL must start with http:// or https://")

        return self


def get_config_from_env() -> BlueBubblesConfig | None:
    """Gets BlueBubbles configuration from environment variables."""
    server_url = os.getenv("BLUEBUBBLES_SERVER_URL")
    password = os.getenv("BLUEBUBBLES_PASSWORD")

    if not server_url or not password:
        return None

    def parse_allow_list(raw: str | None) -> list[str]:
        if not raw:
            return []
        return [s.strip() for s in raw.split(",") if s.strip()]

    dm_policy_str = os.getenv("BLUEBUBBLES_DM_POLICY", "pairing").lower()
    group_policy_str = os.getenv("BLUEBUBBLES_GROUP_POLICY", "allowlist").lower()

    dm_policy_map = {
        "open": DmPolicy.OPEN,
        "pairing": DmPolicy.PAIRING,
        "allowlist": DmPolicy.ALLOWLIST,
        "disabled": DmPolicy.DISABLED,
    }

    group_policy_map = {
        "open": GroupPolicy.OPEN,
        "allowlist": GroupPolicy.ALLOWLIST,
        "disabled": GroupPolicy.DISABLED,
    }

    return BlueBubblesConfig(
        server_url=server_url,
        password=password,
        webhook_path=os.getenv("BLUEBUBBLES_WEBHOOK_PATH", DEFAULT_WEBHOOK_PATH),
        dm_policy=dm_policy_map.get(dm_policy_str, DmPolicy.PAIRING),
        group_policy=group_policy_map.get(group_policy_str, GroupPolicy.ALLOWLIST),
        allow_from=parse_allow_list(os.getenv("BLUEBUBBLES_ALLOW_FROM")),
        group_allow_from=parse_allow_list(os.getenv("BLUEBUBBLES_GROUP_ALLOW_FROM")),
        send_read_receipts=os.getenv("BLUEBUBBLES_SEND_READ_RECEIPTS", "true").lower() != "false",
        enabled=os.getenv("BLUEBUBBLES_ENABLED", "true").lower() != "false",
    )


def normalize_handle(handle: str) -> str:
    """Normalizes a phone number or email handle."""
    trimmed = handle.strip()

    # If it looks like an email, lowercase it
    if "@" in trimmed and not trimmed.startswith("+"):
        return trimmed.lower()

    # For phone numbers, strip non-digits except leading +
    starts_with_plus = trimmed.startswith("+")
    digits = re.sub(r"\D", "", trimmed)

    # Add + prefix if it was there or if we have 10+ digits (assume international)
    if starts_with_plus or len(digits) >= 10:
        return f"+{digits}"

    return digits


def is_handle_allowed(handle: str, allow_list: list[str], policy: DmPolicy) -> bool:
    """Checks if a handle is allowed based on policy."""
    if policy == DmPolicy.OPEN:
        return True

    if policy == DmPolicy.DISABLED:
        return False

    if policy in (DmPolicy.PAIRING, DmPolicy.ALLOWLIST):
        if not allow_list and policy == DmPolicy.PAIRING:
            # Pairing mode with empty allow list allows first contact
            return True

        normalized = normalize_handle(handle)
        return any(normalize_handle(allowed) == normalized for allowed in allow_list)

    return False


def is_group_handle_allowed(handle: str, allow_list: list[str], policy: GroupPolicy) -> bool:
    """Checks if a handle is allowed for groups."""
    if policy == GroupPolicy.OPEN:
        return True

    if policy == GroupPolicy.DISABLED:
        return False

    if policy == GroupPolicy.ALLOWLIST:
        normalized = normalize_handle(handle)
        return any(normalize_handle(allowed) == normalized for allowed in allow_list)

    return False
