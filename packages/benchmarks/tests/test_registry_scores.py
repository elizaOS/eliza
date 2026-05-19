from __future__ import annotations

import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent))

from registry.scores import _score_from_hermes_env_json  # noqa: E402


def test_hermes_env_placeholder_only_score_is_not_publishable() -> None:
    with pytest.raises(ValueError, match="placeholder-only"):
        _score_from_hermes_env_json(
            {
                "score": 0.0,
                "higher_is_better": True,
                "metrics": {"placeholder": 0.0},
                "env_id_public": "hermes_swe_env",
            }
        )


def test_hermes_env_real_metric_with_placeholder_is_publishable() -> None:
    extraction = _score_from_hermes_env_json(
        {
            "score": 0.25,
            "higher_is_better": True,
            "metrics": {"placeholder": 0.0, "pass_rate": 0.25},
            "env_id_public": "hermes_terminalbench_2",
        }
    )

    assert extraction.score == pytest.approx(0.25)
    assert extraction.metrics["pass_rate"] == pytest.approx(0.25)


def test_hermes_env_all_incomplete_zero_is_not_publishable() -> None:
    with pytest.raises(ValueError, match="incomplete"):
        _score_from_hermes_env_json(
            {
                "score": 0.0,
                "higher_is_better": True,
                "metrics": {
                    "pass_rate": 0.0,
                    "total_tasks": 1,
                    "sample_rows": 1,
                    "incomplete_rollouts": 1,
                },
                "env_id_public": "hermes_tblite",
            }
        )
