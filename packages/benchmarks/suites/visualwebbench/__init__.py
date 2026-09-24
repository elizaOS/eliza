"""VisualWebBench benchmark scaffold."""

from benchmarks.visualwebbench.dataset import VisualWebBenchDataset
from benchmarks.visualwebbench.evaluator import VisualWebBenchEvaluator
from benchmarks.visualwebbench.runner import VisualWebBenchRunner
from benchmarks.visualwebbench.types import (
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
