"""Names and recognizes benchmark campaign profiles across registry and orchestrator layers.

The canonical exhaustive profile is intentionally distinct from benchmark-local
``full`` modes. A compatibility alias remains accepted for operator-built
commands, while campaign manifests always persist the canonical value.
"""

from __future__ import annotations

from typing import Final


FULL_CAMPAIGN_PROFILE: Final = "claude-subscription-full-v1"
LEGACY_FULL_CAMPAIGN_PROFILE: Final = "full"


def is_full_campaign_profile(value: object) -> bool:
    """Return whether ``value`` selects the exhaustive campaign profile."""

    if not isinstance(value, str):
        return False
    return value.strip().lower() in {
        FULL_CAMPAIGN_PROFILE,
        LEGACY_FULL_CAMPAIGN_PROFILE,
    }
