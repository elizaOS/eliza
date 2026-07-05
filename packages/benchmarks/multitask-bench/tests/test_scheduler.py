"""Wave-partitioning determinism and the hermetic Perfect/Wrong lane runs.

Drives the real scheduler + the real LifeOpsBench runner through the frozen
sample with the deterministic Perfect/Wrong oracles (no model, no keys), so
these assertions exercise the actual concurrency path rather than a mock of it.
"""

from __future__ import annotations

import pytest

from multitask_bench.metrics import compute_interference, compute_lane_metrics
from multitask_bench.sample import MULTITASK_SAMPLE
from multitask_bench.scheduler import partition_waves


def test_partition_waves_is_deterministic_and_exact() -> None:
    scenarios = MULTITASK_SAMPLE
    assert len(scenarios) == 10

    n1 = partition_waves(scenarios, 1)
    assert len(n1) == 10
    assert all(len(w) == 1 for w in n1)

    n5 = partition_waves(scenarios, 5)
    assert len(n5) == 2
    assert [len(w) for w in n5] == [5, 5]

    n10 = partition_waves(scenarios, 10)
    assert len(n10) == 1
    assert len(n10[0]) == 10

    # Same sample + N always slices identically — this is what lets the
    # interference delta line up (scenario, seed) pairs across lanes.
    assert partition_waves(scenarios, 5) == n5
    # Wave order preserves sample order.
    assert [s.id for w in n5 for s in w] == [s.id for s in scenarios]


def test_partition_waves_rejects_zero() -> None:
    with pytest.raises(ValueError):
        partition_waves(MULTITASK_SAMPLE, 0)


def test_perfect_lane_scores_one_with_no_interference(perfect_lanes) -> None:
    metrics = [compute_lane_metrics(lane) for lane in perfect_lanes]
    assert [m["n"] for m in metrics] == [1, 5, 10]
    for m in metrics:
        assert m["tasks_completed"] == 10
        assert m["completion_rate"] == 1.0
        assert m["mean_task_score"] == pytest.approx(1.0)
        assert m["starved_tasks"] == 0

    interference = compute_interference(metrics)
    # A perfect oracle scores each task identically alone and under load, so
    # every interference delta is exactly zero.
    assert interference["n5_minus_n1"] == pytest.approx(0.0)
    assert interference["n10_minus_n1"] == pytest.approx(0.0)


def test_wrong_lane_scores_zero_with_no_starvation(wrong_lanes) -> None:
    metrics = [compute_lane_metrics(lane) for lane in wrong_lanes]
    for m in metrics:
        # Wrong agent terminates cleanly (a refusal), so tasks complete but
        # score zero — this is a completed zero, never a starved/timed-out one.
        assert m["tasks_completed"] == 10
        assert m["mean_task_score"] == pytest.approx(0.0)
        assert m["starved_tasks"] == 0

    interference = compute_interference(metrics)
    assert interference["n5_minus_n1"] == pytest.approx(0.0)
