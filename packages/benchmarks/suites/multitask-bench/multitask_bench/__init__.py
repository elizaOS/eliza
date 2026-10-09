"""MultitaskBench — one agent handling N interleaved LifeOps tasks.

Measures the interference a shared agent incurs when driving N tasks at once
(N=5, N=10) versus one at a time (N=1), reusing the LifeOpsBench runner and its
STATIC scenario corpus. The N=1 lane is the baseline; the headline is the
per-task score delta at N. Harnesses (eliza / hermes / openclaw) differ in
isolation, disclosed in every report and never erased.
"""

from __future__ import annotations

from .metrics import compute_interference, compute_lane_metrics
from .report import build_report, write_report
from .sample import MULTITASK_SAMPLE, MULTITASK_SCENARIO_IDS
from .scheduler import partition_waves, run_lane
from .types import LaneResult, TaskRun

__all__ = [
    "LaneResult",
    "MULTITASK_SAMPLE",
    "MULTITASK_SCENARIO_IDS",
    "TaskRun",
    "build_report",
    "compute_interference",
    "compute_lane_metrics",
    "partition_waves",
    "run_lane",
    "write_report",
]
