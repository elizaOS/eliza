"""Tests for the Mind2Web DeBERTa candidate ranker (MindAct stage 1).

These tests live alongside ``test_integration.py`` and follow the same
import-path setup. Heavy tests (loading the ~750MB DeBERTa checkpoint) are
gated behind the ``MIND2WEB_RUN_RANKER`` env variable to keep the default
``pytest`` invocation cheap.

The lightweight tests in this module run unconditionally and exercise:
  * ``Mind2WebRankerMode`` enum + config plumbing
  * Oracle / none modes through ``select_candidates_for_step``
  * Oracle agent gating (must require ``use_mock=True``)
  * ``recall_at_k`` semantics
"""

from __future__ import annotations

import logging
import math
import os
import pickle
import sys
from pathlib import Path

import pytest

# Mirror tests/test_integration.py path setup.
REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "packages" / "python"))
sys.path.insert(0, str(REPO_ROOT / "benchmarks"))

logger = logging.getLogger(__name__)


FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "mind2web_sample.pkl"


# ---------------------------------------------------------------------------
# Lightweight tests (always run)
# ---------------------------------------------------------------------------


def test_ranker_mode_enum() -> None:
    from benchmarks.mind2web.types import Mind2WebRankerMode

    assert Mind2WebRankerMode.REAL.value == "real"
    assert Mind2WebRankerMode.ORACLE.value == "oracle"
    assert Mind2WebRankerMode.NONE.value == "none"


def test_config_default_ranker_mode_is_real() -> None:
    """Default ranker mode must be REAL (the leaderboard-faithful one)."""
    from benchmarks.mind2web.types import Mind2WebConfig, Mind2WebRankerMode

    cfg = Mind2WebConfig()
    assert cfg.ranker_mode == Mind2WebRankerMode.REAL
    assert cfg.ranker_top_k == 50


def test_oracle_mode_returns_positives_then_negatives() -> None:
    """Oracle mode must pass GT positives first; recall is NaN by contract."""
    from benchmarks.mind2web.eliza_agent import select_candidates_for_step
    from benchmarks.mind2web.types import (
        Mind2WebActionStep,
        Mind2WebElement,
        Mind2WebOperation,
        Mind2WebRankerMode,
    )

    pos = Mind2WebElement(tag="input", backend_node_id="pos_1", is_original_target=True)
    neg1 = Mind2WebElement(tag="a", backend_node_id="neg_1")
    neg2 = Mind2WebElement(tag="button", backend_node_id="neg_2")
    step = Mind2WebActionStep(
        action_uid="x",
        operation=Mind2WebOperation.CLICK,
        pos_candidates=[pos],
        neg_candidates=[neg1, neg2],
    )

    cands, recall = select_candidates_for_step(
        step,
        mode=Mind2WebRankerMode.ORACLE,
        task_description="test task",
        previous_actions=[],
        top_k=50,
    )
    assert [c.backend_node_id for c in cands] == ["pos_1", "neg_1", "neg_2"]
    assert math.isnan(recall)


def test_none_mode_returns_full_pool_with_nan_recall() -> None:
    from benchmarks.mind2web.eliza_agent import select_candidates_for_step
    from benchmarks.mind2web.types import (
        Mind2WebActionStep,
        Mind2WebElement,
        Mind2WebOperation,
        Mind2WebRankerMode,
    )

    pos = Mind2WebElement(tag="input", backend_node_id="pos_1", is_original_target=True)
    negs = [Mind2WebElement(tag="a", backend_node_id=f"neg_{i}") for i in range(5)]
    step = Mind2WebActionStep(
        action_uid="x",
        operation=Mind2WebOperation.CLICK,
        pos_candidates=[pos],
        neg_candidates=negs,
    )

    cands, recall = select_candidates_for_step(
        step,
        mode=Mind2WebRankerMode.NONE,
        task_description="test task",
        previous_actions=[],
        top_k=50,
    )
    assert len(cands) == 6
    assert math.isnan(recall)


def test_oracle_agent_refuses_without_mock_flag() -> None:
    """OracleMind2WebAgent must refuse to run unless --mock is set."""
    from benchmarks.mind2web.eliza_agent import OracleMind2WebAgent
    from benchmarks.mind2web.types import Mind2WebConfig

    with pytest.raises(RuntimeError, match="use_mock"):
        OracleMind2WebAgent(Mind2WebConfig(use_mock=False))

    # With use_mock=True it should construct fine.
    agent = OracleMind2WebAgent(Mind2WebConfig(use_mock=True))
    assert agent is not None


def test_mock_alias_is_oracle() -> None:
    """The legacy ``MockMind2WebAgent`` name must point at OracleMind2WebAgent."""
    from benchmarks.mind2web.eliza_agent import MockMind2WebAgent, OracleMind2WebAgent

    assert MockMind2WebAgent is OracleMind2WebAgent


def test_recall_at_k_semantics() -> None:
    from benchmarks.mind2web.ranker import RankedCandidate, recall_at_k
    from benchmarks.mind2web.types import (
        Mind2WebActionStep,
        Mind2WebElement,
        Mind2WebOperation,
    )

    pos = Mind2WebElement(tag="input", backend_node_id="pos_1", is_original_target=True)
    neg = Mind2WebElement(tag="a", backend_node_id="neg_1")
    step = Mind2WebActionStep(
        action_uid="x",
        operation=Mind2WebOperation.CLICK,
        pos_candidates=[pos],
        neg_candidates=[neg],
    )

    # Positive is in the top-K -> recall 1.0.
    ranked_hit = [
        RankedCandidate(element=pos, score=0.9, is_pos=True),
        RankedCandidate(element=neg, score=0.1, is_pos=False),
    ]
    assert recall_at_k(ranked_hit, step) == 1.0

    # Positive missing -> recall 0.0.
    ranked_miss = [RankedCandidate(element=neg, score=0.5, is_pos=False)]
    assert recall_at_k(ranked_miss, step) == 0.0

    # No positives at all -> NaN (caller should skip in aggregation).
    empty_step = Mind2WebActionStep(
        action_uid="y", operation=Mind2WebOperation.CLICK, pos_candidates=[]
    )
    assert math.isnan(recall_at_k([], empty_step))


def test_cli_parses_ranker_flag() -> None:
    from benchmarks.mind2web.cli import create_config, parse_args
    from benchmarks.mind2web.types import Mind2WebRankerMode

    original = sys.argv
    try:
        sys.argv = ["mind2web", "--sample", "--ranker", "oracle", "--ranker-top-k", "10"]
        args = parse_args()
        cfg = create_config(args)
        assert cfg.ranker_mode == Mind2WebRankerMode.ORACLE
        assert cfg.ranker_top_k == 10
    finally:
        sys.argv = original


# ---------------------------------------------------------------------------
# Heavy end-to-end test (gated)
# ---------------------------------------------------------------------------


def _load_fixture():
    """Load a small Mind2Web sample (pickled list of Mind2WebActionStep)."""
    if not FIXTURE_PATH.exists():
        pytest.skip(
            f"Mind2Web ranker fixture not present at {FIXTURE_PATH}. "
            f"Run scripts/build_ranker_fixture.py or set "
            f"MIND2WEB_RUN_RANKER=1 with network access to build it."
        )
    with FIXTURE_PATH.open("rb") as f:
        return pickle.load(f)


@pytest.mark.skipif(
    os.environ.get("MIND2WEB_RUN_RANKER") != "1",
    reason=(
        "DeBERTa ranker download/inference is heavy; set MIND2WEB_RUN_RANKER=1 "
        "to enable. The first run downloads ~750MB from HuggingFace."
    ),
)
def test_ranker_recall_above_threshold_on_fixture() -> None:
    """Loaded checkpoint should hit Recall@50 > 0.8 on the fixture.

    Upstream reports ~88-92% Recall@50 on test_task with this checkpoint
    (Deng et al. 2023, Table 4). We give a generous 0.8 floor to allow for the
    5-row fixture's variance.
    """
    from benchmarks.mind2web.ranker import recall_at_k, score_candidates

    fixture = _load_fixture()  # list of (task_description, previous_actions, step)
    assert len(fixture) >= 1, "Fixture must contain >= 1 step"

    recalls: list[float] = []
    for task_description, previous_actions, step in fixture:
        ranked = score_candidates(
            step,
            task_description=task_description,
            previous_actions=previous_actions,
            top_k=50,
        )
        r = recall_at_k(ranked, step)
        if not math.isnan(r):
            recalls.append(r)

    assert recalls, "Fixture had no scorable steps with GT positives"
    mean_recall = sum(recalls) / len(recalls)
    logger.info(
        "Ranker Recall@50 on %d-step fixture: %.3f (target > 0.8)",
        len(recalls),
        mean_recall,
    )
    assert mean_recall > 0.8, (
        f"Ranker Recall@50 = {mean_recall:.3f} on the fixture; expected > 0.8 "
        f"(upstream reports ~0.88-0.92 on test_task)."
    )
