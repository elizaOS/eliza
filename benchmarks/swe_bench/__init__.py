"""SWE-bench benchmark for ElizaOS Python."""

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
from .dataset import SWEBenchDataset, DatasetStatistics
from .evaluator import PatchQualityResult, SimplePatchEvaluator, SWEBenchEvaluator
from .agent import AgentResponse, SWEAgent
from .repo_manager import RepositoryManager
from .runner import SWEBenchRunner
from .plugin import RepoManagerService, create_swe_bench_plugin, swe_bench_plugin

__all__ = [
    # Types
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
    # Dataset
    "SWEBenchDataset",
    "DatasetStatistics",
    # Evaluator
    "PatchQualityResult",
    "SimplePatchEvaluator",
    "SWEBenchEvaluator",
    # Agent
    "AgentResponse",
    "SWEAgent",
    # Repository
    "RepositoryManager",
    # Runner
    "SWEBenchRunner",
    # Plugin
    "RepoManagerService",
    "create_swe_bench_plugin",
    "swe_bench_plugin",
]
