"""Tests for the Eliza-1 publish dispatcher release-mode choices."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.publish import publish_model  # noqa: E402


def test_legacy_optimized_mode_is_not_a_dispatch_choice() -> None:
    with pytest.raises(SystemExit) as exc:
        publish_model.main(["--mode", "optimized"])

    assert exc.value.code == 2
