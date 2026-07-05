"""Unit coverage for the pure metric functions on synthetic task runs.

Builds ``TaskRun`` records directly (with hand-made ``ScenarioResult`` /
``TurnResult`` payloads) so Jain fairness, starvation classification,
percentiles, and interference math are pinned independent of any live run.
"""

from __future__ import annotations

import pytest
from eliza_lifeops_bench.types import ScenarioResult, TurnResult

from multitask_bench.metrics import (
    compute_interference,
    is_completed,
    is_starved,
    jain_fairness,
    percentiles,
)
from multitask_bench.types import TaskRun


def _turn(latency_ms: int | None = 10) -> TurnResult:
    return TurnResult(
        turn_number=1,
        agent_message="",
        agent_actions=[],
        user_response="",
        latency_ms=latency_ms,
        input_tokens=5,
        output_tokens=3,
        cost_usd=0.001,
        tool_results=[],
    )


def _result(
    scenario_id: str,
    *,
    total_score: float,
    reason: str,
    turns: int,
) -> ScenarioResult:
    return ScenarioResult(
        scenario_id=scenario_id,
        seed=2026,
        turns=[_turn() for _ in range(turns)],
        state_hash_match=total_score >= 1.0,
        output_substring_matches=[],
        total_score=total_score,
        max_score=1.0,
        terminated_reason=reason,  # type: ignore[arg-type]
        total_cost_usd=0.001 * turns,
        total_latency_ms=10 * turns,
    )


def _task(
    scenario_id: str,
    *,
    score: float = 1.0,
    reason: str = "respond",
    turns: int = 2,
    wave: int = 0,
    wall_s: float = 1.0,
    with_result: bool = True,
) -> TaskRun:
    result = (
        _result(scenario_id, total_score=score, reason=reason, turns=turns)
        if with_result
        else None
    )
    return TaskRun(
        scenario_id=scenario_id,
        seed=2026,
        wave_index=wave,
        terminated_reason=reason,
        task_wall_s=wall_s,
        result=result,
    )


def test_jain_fairness_edges() -> None:
    assert jain_fairness([]) == 0.0
    assert jain_fairness([0, 0, 0]) == 0.0
    # Perfectly equal allocation.
    assert jain_fairness([3, 3, 3]) == pytest.approx(1.0)
    # Single task is trivially fair.
    assert jain_fairness([7]) == pytest.approx(1.0)
    # One task monopolizes: index approaches 1/n.
    assert jain_fairness([10, 0, 0, 0]) == pytest.approx(0.25)


def test_percentiles_nearest_rank() -> None:
    empty = percentiles([])
    assert empty == {"p50": 0.0, "p95": 0.0, "max": 0.0}
    vals = [float(x) for x in range(1, 11)]  # 1..10
    got = percentiles(vals)
    assert got["max"] == 10.0
    # Nearest-rank p50 of 10 samples = the 5th ordered value.
    assert got["p50"] == 5.0
    # p95 = the 10th (ceil(0.95*10)=10).
    assert got["p95"] == 10.0


def test_starvation_zero_turns_is_starved() -> None:
    task = _task("a", turns=0, reason="timeout", with_result=False)
    # A task that produced zero turns never got a slice — starved regardless of
    # whether a peer completed.
    assert is_starved(task, wave_had_completion=False) is True


def test_starvation_timeout_needs_peer_completion() -> None:
    timed_out = _task("a", reason="timeout", turns=3)
    # Timed out with a completed peer → starved (agent served others).
    assert is_starved(timed_out, wave_had_completion=True) is True
    # Timed out but NO peer completed → the whole wave stalled, not starvation
    # of this one task specifically.
    assert is_starved(timed_out, wave_had_completion=False) is False


def test_completed_gates_on_reason() -> None:
    assert is_completed(_task("a", reason="respond")) is True
    assert is_completed(_task("a", reason="max_turns")) is True
    assert is_completed(_task("a", reason="timeout", with_result=False)) is False
    assert is_completed(_task("a", reason="error", with_result=False)) is False


def test_incomplete_task_scores_zero_not_fabricated() -> None:
    task = _task("a", reason="timeout", with_result=False)
    # No result → score 0.0, and it is NOT counted as completed.
    assert task.score == 0.0
    assert is_completed(task) is False


def test_interference_requires_baseline() -> None:
    lane5 = {"n": 5, "per_task": [{"scenario_id": "a", "seed": 2026, "score": 0.5}]}
    with pytest.raises(ValueError, match="baseline"):
        compute_interference([lane5])


def test_interference_delta_over_matched_pairs() -> None:
    lane1 = {
        "n": 1,
        "per_task": [
            {"scenario_id": "a", "seed": 2026, "score": 1.0},
            {"scenario_id": "b", "seed": 2026, "score": 1.0},
        ],
    }
    lane5 = {
        "n": 5,
        "per_task": [
            {"scenario_id": "a", "seed": 2026, "score": 0.5},
            {"scenario_id": "b", "seed": 2026, "score": 0.5},
        ],
    }
    deltas = compute_interference([lane1, lane5])
    # Each task lost 0.5 under load → mean delta -0.5.
    assert deltas["n5_minus_n1"] == pytest.approx(-0.5)


def test_interference_no_shared_pairs_raises() -> None:
    lane1 = {"n": 1, "per_task": [{"scenario_id": "a", "seed": 2026, "score": 1.0}]}
    lane5 = {"n": 5, "per_task": [{"scenario_id": "z", "seed": 9, "score": 0.5}]}
    with pytest.raises(ValueError, match="shares no"):
        compute_interference([lane1, lane5])
