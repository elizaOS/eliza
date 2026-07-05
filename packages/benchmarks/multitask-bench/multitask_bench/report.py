"""Assemble and write the ``multitask_<timestamp>.json`` report.

The report is the benchmark's contract with the registry scorer
(``registry/scores.py::_score_from_multitask_bench_json``): a top-level
``lanes[]`` of per-lane metric blocks plus the cross-lane ``interference``
deltas, tagged with the harness's ``isolation`` mode so a shared-runtime eliza
run is never silently compared against a process-isolated hermes/openclaw run.
The scalar registry score is the ``mean_task_score`` of the N=10 lane; the
interference deltas are the headline a human reads.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .harness import HARNESS_ISOLATION
from .metrics import compute_interference, compute_lane_metrics
from .types import LaneResult

__all__ = ["build_report", "write_report"]


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
            f"unknown harness {harness!r}; expected one of "
            f"{sorted(HARNESS_ISOLATION)}"
        )
    lanes_metrics = [compute_lane_metrics(lane) for lane in lanes]
    interference = compute_interference(lanes_metrics)
    return {
        "benchmark": "multitask_bench",
        "harness": harness,
        "isolation": isolation,
        "model": model,
        "sample": {
            "scenario_ids": scenario_ids,
            "size": len(scenario_ids),
        },
        "lanes": lanes_metrics,
        "interference": interference,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def write_report(report: dict[str, object], output_dir: Path) -> Path:
    """Write ``report`` to ``multitask_<utc-timestamp>.json`` under ``output_dir``."""
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = output_dir / f"multitask_{stamp}.json"
    path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    return path
