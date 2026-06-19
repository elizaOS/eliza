"""SWE-bench benchmark.

The agent loop runs against the eliza TypeScript benchmark HTTP server via
``eliza_adapter.swe_bench`` (TEXT_LARGE handler) plus a thin Python harness that
loads instances, applies patches, and scores diffs.
"""

from .dataset import DatasetStatistics, SWEBenchDataset
from .evaluator import PatchQualityResult, SimplePatchEvaluator, SWEBenchEvaluator
from .repo_manager import RepositoryManager
from .types import (
    LEADERBOARD_SCORES,
    AgentStep,
    AgentTrajectory,
    CodeLocation,
    PatchStatus,
    RepoStats,
    SWEBenchConfig,
    SWEBenchInstance,
    SWEBenchReport,
    SWEBenchResult,
    SWEBenchVariant,
)

__all__ = [
    "SWEBenchVariant",
    "PatchStatus",
    "SWEBenchInstance",
    "SWEBenchResult",
    "SWEBenchReport",
    "SWEBenchConfig",
    "CodeLocation",
    "AgentStep",
    "AgentTrajectory",
    "RepoStats",
    "LEADERBOARD_SCORES",
    "SWEBenchDataset",
    "DatasetStatistics",
    "PatchQualityResult",
    "SimplePatchEvaluator",
    "SWEBenchEvaluator",
    "RepositoryManager",
]
