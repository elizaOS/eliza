"""Canonical exhaustive campaign profile shared by registry and orchestrator."""

from __future__ import annotations

from typing import Final


FULL_CAMPAIGN_PROFILE: Final = "claude-subscription-full-v1"


def is_full_campaign_profile(value: object) -> bool:
    """Return whether ``value`` selects the exhaustive campaign profile."""

    if not isinstance(value, str):
        return False
    return value.strip().lower() == FULL_CAMPAIGN_PROFILE
