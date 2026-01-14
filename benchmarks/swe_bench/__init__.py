"""SWE-bench benchmark for ElizaOS Python."""

from .agent import ParsedResponse, SWEAgent, TRAJECTORY_LOGGER_AVAILABLE
from .character import (
    SWE_BENCH_MESSAGE_HANDLER_TEMPLATE,
    SWE_BENCH_REPLY_TEMPLATE,
    create_swe_bench_character,
    swe_bench_character,
)
from .dataset import DatasetStatistics, SWEBenchDataset
from .evaluator import PatchQualityResult, SimplePatchEvaluator, SWEBenchEvaluator
from .plugin import RepoManagerService, create_swe_bench_plugin, swe_bench_plugin
from .providers import (
    SWE_BENCH_PROVIDERS,
    SWEBenchActionResultsProvider,
    get_current_instance,
    set_current_instance,
    swe_bench_action_results_provider,
    swe_bench_issue_provider,
    swe_bench_repo_structure_provider,
    swe_bench_strategy_provider,
    swe_bench_tools_provider,
)
from .repo_manager import RepositoryManager
from .runner import SWEBenchRunner
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
    "ParsedResponse",
    "SWEAgent",
    "TRAJECTORY_LOGGER_AVAILABLE",
    # Character
    "create_swe_bench_character",
    "swe_bench_character",
    "SWE_BENCH_MESSAGE_HANDLER_TEMPLATE",
    "SWE_BENCH_REPLY_TEMPLATE",
    # Providers
    "SWE_BENCH_PROVIDERS",
    "swe_bench_issue_provider",
    "swe_bench_tools_provider",
    "swe_bench_repo_structure_provider",
    "swe_bench_strategy_provider",
    "swe_bench_action_results_provider",
    "SWEBenchActionResultsProvider",
    "set_current_instance",
    "get_current_instance",
    # Repository
    "RepositoryManager",
    # Runner
    "SWEBenchRunner",
    # Plugin
    "RepoManagerService",
    "create_swe_bench_plugin",
    "swe_bench_plugin",
]
