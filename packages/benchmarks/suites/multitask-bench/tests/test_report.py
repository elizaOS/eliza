"""Report assembly + on-disk schema round-trip, plus sample validation.

Runs the hermetic perfect harness through the real scheduler, builds the
report, writes it, reads it back, and asserts the exact top-level and per-lane
key set the registry scorer depends on — so a schema drift fails here rather
than silently at score-extraction time.
"""

from __future__ import annotations

import json
from dataclasses import replace

import pytest

from multitask_bench.report import build_report, write_report
from multitask_bench.sample import (
    MULTITASK_SAMPLE,
    MULTITASK_SCENARIO_IDS,
    sample_seed,
)

_TOP_KEYS = {
    "benchmark",
    "complete",
    "harness",
    "isolation",
    "comparison_scope",
    "cross_harness_comparable",
    "model",
    "sample",
    "lanes",
    "interference",
    "timestamp",
}
_LANE_KEYS = {
    "n",
    "arrival",
    "waves",
    "tasks_total",
    "tasks_completed",
    "completion_rate",
    "mean_task_score",
    "throughput_tasks_per_min",
    "wall_clock_s",
    "turn_latency_ms",
    "task_wall_s",
    "cost_usd",
    "tokens",
    "starved_tasks",
    "starvation_rate",
    "fairness_turns_jain",
    "lifecycle_events",
    "per_task",
}


def test_sample_is_ten_distinct_static_scenarios() -> None:
    assert len(MULTITASK_SCENARIO_IDS) == 10
    assert len(set(MULTITASK_SCENARIO_IDS)) == 10
    assert [s.id for s in MULTITASK_SAMPLE] == MULTITASK_SCENARIO_IDS
    # Every sample scenario is STATIC (no judge / simulated user).
    for s in MULTITASK_SAMPLE:
        assert s.mode.name == "STATIC", f"{s.id} is not STATIC"
    # Ten distinct domains, one per surface.
    assert len({s.domain for s in MULTITASK_SAMPLE}) == 10
    # Seed is the scenario's world_seed (no per-lane offset).
    for s in MULTITASK_SAMPLE:
        assert sample_seed(s) == s.world_seed


def test_report_round_trips_with_expected_schema(perfect_lanes, tmp_path) -> None:
    report = build_report(
        harness="perfect",
        model="oracle",
        lanes=perfect_lanes,
        scenario_ids=MULTITASK_SCENARIO_IDS,
    )
    assert set(report.keys()) == _TOP_KEYS
    assert report["benchmark"] == "multitask_bench"
    assert report["complete"] is True
    assert report["isolation"] == "shared_runtime"
    assert report["comparison_scope"] == "within_harness_only"
    assert report["cross_harness_comparable"] is False
    assert report["sample"]["scenario_ids"] == MULTITASK_SCENARIO_IDS
    assert report["sample"]["expected_attempts_per_lane"] == 10
    assert len(report["sample"]["workload_sha256"]) == 64
    assert set(report["interference"].keys()) == {"n5_minus_n1", "n10_minus_n1"}

    lane_block = report["lanes"]
    assert [lane["n"] for lane in lane_block] == [1, 5, 10]
    for lane in lane_block:
        assert set(lane.keys()) == _LANE_KEYS
        assert lane["arrival"] == "batch"
        assert set(lane["cost_usd"].keys()) == {"total", "per_completed_task"}
        assert set(lane["tokens"].keys()) == {"prompt", "completion"}
        assert set(lane["turn_latency_ms"].keys()) == {"p50", "p95", "max"}
        assert len(lane["per_task"]) == lane["tasks_total"]

    path = write_report(report, tmp_path)
    assert path.exists()
    round_tripped = json.loads(path.read_text(encoding="utf-8"))
    assert round_tripped["benchmark"] == "multitask_bench"
    assert set(round_tripped.keys()) == _TOP_KEYS


def test_unknown_harness_rejected() -> None:
    with pytest.raises(ValueError, match="unknown harness"):
        build_report(
            harness="nope",
            model="x",
            lanes=[],
            scenario_ids=MULTITASK_SCENARIO_IDS,
        )


def test_incomplete_lane_set_is_rejected(perfect_lanes) -> None:
    with pytest.raises(ValueError, match="requires lanes"):
        build_report(
            harness="perfect",
            model="oracle",
            lanes=perfect_lanes[:2],
            scenario_ids=MULTITASK_SCENARIO_IDS,
        )


def test_lane_missing_sample_attempt_is_rejected(perfect_lanes) -> None:
    incomplete_lanes = [
        *perfect_lanes[:-1],
        replace(perfect_lanes[-1], tasks=perfect_lanes[-1].tasks[:-1]),
    ]

    with pytest.raises(ValueError, match=r"canonical \(scenario, seed\) pair"):
        build_report(
            harness="perfect",
            model="oracle",
            lanes=incomplete_lanes,
            scenario_ids=MULTITASK_SCENARIO_IDS,
        )


def test_noncanonical_sample_ids_are_rejected(perfect_lanes) -> None:
    changed_ids = [*MULTITASK_SCENARIO_IDS]
    changed_ids[-1] = "travel.noncanonical"

    with pytest.raises(ValueError, match="canonical ordered scenario sample"):
        build_report(
            harness="perfect",
            model="oracle",
            lanes=perfect_lanes,
            scenario_ids=changed_ids,
        )


def test_wrong_sample_seed_is_rejected(perfect_lanes) -> None:
    changed_task = replace(
        perfect_lanes[0].tasks[0],
        seed=perfect_lanes[0].tasks[0].seed + 1,
    )
    changed_lane = replace(
        perfect_lanes[0],
        tasks=[changed_task, *perfect_lanes[0].tasks[1:]],
    )

    with pytest.raises(ValueError, match=r"canonical \(scenario, seed\) pair"):
        build_report(
            harness="perfect",
            model="oracle",
            lanes=[changed_lane, *perfect_lanes[1:]],
            scenario_ids=MULTITASK_SCENARIO_IDS,
        )


def test_infrastructure_failure_result_is_rejected(perfect_lanes) -> None:
    source_task = perfect_lanes[0].tasks[0]
    assert source_task.result is not None
    failed_result = replace(
        source_task.result,
        terminated_reason="error",
        error="transport failed",
    )
    failed_task = replace(
        source_task,
        terminated_reason="error",
        result=failed_result,
    )
    changed_lane = replace(
        perfect_lanes[0],
        tasks=[failed_task, *perfect_lanes[0].tasks[1:]],
    )

    with pytest.raises(ValueError, match="infrastructure failure"):
        build_report(
            harness="perfect",
            model="oracle",
            lanes=[changed_lane, *perfect_lanes[1:]],
            scenario_ids=MULTITASK_SCENARIO_IDS,
        )


def test_write_report_rejects_incomplete_report(perfect_lanes, tmp_path) -> None:
    report = build_report(
        harness="perfect",
        model="oracle",
        lanes=perfect_lanes,
        scenario_ids=MULTITASK_SCENARIO_IDS,
    )
    report["complete"] = False

    with pytest.raises(ValueError, match="refusing to publish"):
        write_report(report, tmp_path / "not-created")
    assert not (tmp_path / "not-created").exists()
