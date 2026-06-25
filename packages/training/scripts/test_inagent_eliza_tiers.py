"""Tier-list invariants for the in-agent Eliza-1 verifier."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_TRAINING_ROOT = Path(__file__).resolve().parents[1]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts import test_inagent_eliza as inagent  # noqa: E402
from scripts.manifest.eliza1_manifest import ELIZA_1_TIERS  # noqa: E402


def test_inagent_default_tiers_match_active_eliza1_matrix() -> None:
    assert inagent.ALL_TIERS == list(ELIZA_1_TIERS)
    assert "0_8b" not in inagent.ALL_TIERS
    assert "27b-256k" in inagent.ALL_TIERS


def test_inagent_rejects_retired_tier_requests() -> None:
    with pytest.raises(SystemExit, match="unknown or retired"):
        inagent.resolve_requested_tiers("0_8b", None)


def test_inagent_expands_all_to_active_tiers() -> None:
    assert inagent.resolve_requested_tiers(None, "all") == list(ELIZA_1_TIERS)
