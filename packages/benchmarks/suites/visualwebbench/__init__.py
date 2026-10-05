"""VisualWebBench benchmark scaffold."""

from benchmarks.suites.visualwebbench.dataset import VisualWebBenchDataset
from benchmarks.suites.visualwebbench.evaluator import VisualWebBenchEvaluator
from benchmarks.suites.visualwebbench.runner import VisualWebBenchRunner
from benchmarks.suites.visualwebbench.types import (
    VISUALWEBBENCH_TASK_TYPES,
    VisualWebBenchConfig,
    VisualWebBenchPrediction,
    VisualWebBenchReport,
    VisualWebBenchResult,
    VisualWebBenchTask,
    VisualWebBenchTaskType,
)

__all__ = [
    "VISUALWEBBENCH_TASK_TYPES",
    "VisualWebBenchConfig",
    "VisualWebBenchDataset",
    "VisualWebBenchEvaluator",
    "VisualWebBenchPrediction",
    "VisualWebBenchReport",
    "VisualWebBenchResult",
    "VisualWebBenchRunner",
    "VisualWebBenchTask",
    "VisualWebBenchTaskType",
]
