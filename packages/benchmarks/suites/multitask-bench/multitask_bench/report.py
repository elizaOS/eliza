"""Assemble and write the ``multitask_<timestamp>.json`` report.

The report is the benchmark's contract with the registry scorer
(``registry/scores.py::_score_from_multitask_bench_json``): a top-level
``lanes[]`` of per-lane metric blocks plus the cross-lane ``interference``
deltas. Reports are explicitly within-harness measurements: shared-runtime
Eliza and process-per-turn Hermes/OpenClaw do not measure the same contention
boundary and therefore cannot form a fair cross-harness leaderboard.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import fields, is_dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

from .harness import HARNESS_ISOLATION
from .metrics import compute_interference, compute_lane_metrics
from .sample import MULTITASK_SAMPLE, MULTITASK_SCENARIO_IDS, sample_seed
from .types import LaneResult

__all__ = ["build_report", "write_report"]

_REQUIRED_LANES = (1, 5, 10)


def _canonical_json_value(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if is_dataclass(value):
        return {
            field.name: _canonical_json_value(getattr(value, field.name))
            for field in fields(value)
        }
    if isinstance(value, dict):
        return {str(key): _canonical_json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_canonical_json_value(item) for item in value]
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    raise TypeError(f"unsupported MultitaskBench workload value: {type(value).__name__}")


def _workload_sha256() -> str:
    payload = {
        "schema_version": 1,
        "scenarios": [
            {
                "scenario": _canonical_json_value(scenario),
                "run_seed": sample_seed(scenario),
            }
            for scenario in MULTITASK_SAMPLE
        ],
        "lanes": list(_REQUIRED_LANES),
    }
    canonical = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _validate_complete_sample(lanes: list[LaneResult], scenario_ids: list[str]) -> None:
    """Reject reports that omit a canonical lane or sampled task attempt."""
    if scenario_ids != MULTITASK_SCENARIO_IDS:
        raise ValueError(
            "MultitaskBench requires the canonical ordered scenario sample"
        )

    lane_ids = sorted(lane.n for lane in lanes)
    if lane_ids != list(_REQUIRED_LANES):
        raise ValueError(
            f"MultitaskBench requires lanes {_REQUIRED_LANES}, got {tuple(lane_ids)}"
        )

    expected_keys = [
        (scenario.id, sample_seed(scenario)) for scenario in MULTITASK_SAMPLE
    ]
    for lane in lanes:
        task_keys = [(task.scenario_id, task.seed) for task in lane.tasks]
        if task_keys != expected_keys:
            raise ValueError(
                f"lane N={lane.n} must attempt every canonical (scenario, seed) "
                "pair exactly once and in canonical order"
            )
        expected_waves = math.ceil(len(expected_keys) / lane.n)
        if lane.waves != expected_waves:
            raise ValueError(
                f"lane N={lane.n} has {lane.waves} waves; expected {expected_waves}"
            )
        if not math.isfinite(lane.wall_clock_s) or lane.wall_clock_s < 0:
            raise ValueError(f"lane N={lane.n} has invalid wall-clock duration")

        for task_index, task in enumerate(lane.tasks):
            expected_wave_index = task_index // lane.n
            if task.wave_index != expected_wave_index:
                raise ValueError(
                    f"lane N={lane.n} task {task.scenario_id} has wave "
                    f"{task.wave_index}; expected {expected_wave_index}"
                )
            if not math.isfinite(task.task_wall_s) or task.task_wall_s < 0:
                raise ValueError(
                    f"lane N={lane.n} task {task.scenario_id} has invalid duration"
                )
            if task.result is None:
                if task.terminated_reason != "timeout":
                    raise ValueError(
                        f"lane N={lane.n} task {task.scenario_id} has no result "
                        "without a scheduler timeout"
                    )
                continue

            result = task.result
            if (
                result.scenario_id != task.scenario_id
                or result.seed != task.seed
                or result.terminated_reason != task.terminated_reason
            ):
                raise ValueError(
                    f"lane N={lane.n} task {task.scenario_id} result identity "
                    "does not match its scheduled attempt"
                )
            if result.error is not None or result.terminated_reason in {
                "error",
                "timeout",
                "cost_exceeded",
            }:
                raise ValueError(
                    f"lane N={lane.n} task {task.scenario_id} contains an "
                    "infrastructure failure result"
                )
            if (
                not math.isfinite(result.total_score)
                or not math.isfinite(result.max_score)
                or result.max_score <= 0
                or not 0 <= result.total_score <= result.max_score
            ):
                raise ValueError(
                    f"lane N={lane.n} task {task.scenario_id} has invalid score"
                )


def build_report(
    *,
    harness: str,
    model: str,
    lanes: list[LaneResult],
    scenario_ids: list[str],
) -> dict[str, object]:
    """Build the report dict from a set of completed lanes."""
    isolation = HARNESS_ISOLATION.get(harness)
    if isolation is None:
        raise ValueError(
            f"unknown harness {harness!r}; expected one of {sorted(HARNESS_ISOLATION)}"
        )
    _validate_complete_sample(lanes, scenario_ids)
    lanes_metrics = [compute_lane_metrics(lane) for lane in lanes]
    interference = compute_interference(lanes_metrics)
    return {
        "benchmark": "multitask_bench",
        "complete": True,
        "harness": harness,
        "isolation": isolation,
        "comparison_scope": "within_harness_only",
        "cross_harness_comparable": False,
        "model": model,
        "sample": {
            "source": "fixed_lifeops_sample_v1",
            "scenario_ids": list(scenario_ids),
            "size": len(scenario_ids),
            "expected_attempts_per_lane": len(scenario_ids),
            "workload_sha256": _workload_sha256(),
        },
        "lanes": lanes_metrics,
        "interference": interference,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def write_report(report: dict[str, object], output_dir: Path) -> Path:
    """Write ``report`` to ``multitask_<utc-timestamp>.json`` under ``output_dir``."""
    sample = report.get("sample")
    if (
        report.get("complete") is not True
        or not isinstance(sample, dict)
        or sample.get("scenario_ids") != MULTITASK_SCENARIO_IDS
        or sample.get("expected_attempts_per_lane") != len(MULTITASK_SCENARIO_IDS)
        or not isinstance(sample.get("workload_sha256"), str)
        or len(sample["workload_sha256"]) != 64
    ):
        raise ValueError(
            "refusing to publish incomplete or unprovenanced MultitaskBench report"
        )
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = output_dir / f"multitask_{stamp}.json"
    path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    return path
