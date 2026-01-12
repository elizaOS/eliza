"""
REALM-Bench: Real-World Planning Benchmark for ElizaOS

This benchmark evaluates the planning capabilities of LLM-based agents
on complex, real-world tasks requiring multi-step reasoning and execution.

Reference: https://arxiv.org/abs/2412.13102
GitHub: https://github.com/genglongling/REALM-Bench
"""

from benchmarks.realm.types import (
    REALMCategory,
    REALMConfig,
    REALMMetrics,
    REALMReport,
    REALMResult,
    REALMResultMetrics,
    REALMResultDetails,
    REALMTask,
    REALMTestCase,
    PlanningAction,
    PlanningStep,
    PlanningTrajectory,
    PlanStatus,
    ExecutionModel,
    LEADERBOARD_SCORES,
)
from benchmarks.realm.dataset import REALMDataset
from benchmarks.realm.agent import REALMAgent, MockREALMAgent, ELIZAOS_AVAILABLE
from benchmarks.realm.evaluator import REALMEvaluator, MetricsCalculator
from benchmarks.realm.runner import REALMRunner

__all__ = [
    # Types
    "REALMCategory",
    "REALMConfig",
    "REALMMetrics",
    "REALMReport",
    "REALMResult",
    "REALMResultMetrics",
    "REALMResultDetails",
    "REALMTask",
    "REALMTestCase",
    "PlanningAction",
    "PlanningStep",
    "PlanningTrajectory",
    "PlanStatus",
    "ExecutionModel",
    "LEADERBOARD_SCORES",
    # Components
    "REALMDataset",
    "REALMAgent",
    "MockREALMAgent",
    "REALMEvaluator",
    "MetricsCalculator",
    "REALMRunner",
    # Availability flag
    "ELIZAOS_AVAILABLE",
]
