"""
REALM-Bench: Real-World Planning Benchmark for LLMs and Multi-Agent Systems.

Faithful implementation of the 11 canonical scenarios (P1..P11) from:

    Geng et al., arXiv:2502.18836
    https://github.com/genglongling/REALM-Bench

Upstream task definitions, instance datasets, and JSSP benchmarks are
vendored under ``packages/benchmarks/realm/upstream/`` (see
``upstream/ATTRIBUTION.md``).

The agent loop targets the eliza TS bridge via
``eliza_adapter.realm.ElizaREALMAgent``. A deterministic
``_MockREALMAgent`` is exposed for smoke tests and CI.
"""

from benchmarks.realm.dataset import REALMDataset
from benchmarks.realm.evaluator import MetricsCalculator, REALMEvaluator
from benchmarks.realm.runner import REALMRunner
from benchmarks.realm.types import (
    LEADERBOARD_NOTE,
    LEADERBOARD_SCORES,
    MULTI_AGENT_PROBLEMS,
    PROBLEM_DESCRIPTIONS,
    PROBLEM_TO_FAMILY,
    PROBLEMS_WITH_DISRUPTIONS,
    ExecutionModel,
    OracleFamily,
    PlanningAction,
    PlanningStep,
    PlanningTrajectory,
    PlanStatus,
    REALMCategory,  # back-compat alias for RealmProblem
    REALMConfig,
    REALMMetrics,
    REALMReport,
    REALMResult,
    REALMResultDetails,
    REALMResultMetrics,
    REALMTask,
    REALMTestCase,
    RealmProblem,
)

__all__ = [
    "RealmProblem",
    "REALMCategory",
    "OracleFamily",
    "PROBLEM_TO_FAMILY",
    "PROBLEMS_WITH_DISRUPTIONS",
    "MULTI_AGENT_PROBLEMS",
    "PROBLEM_DESCRIPTIONS",
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
    "LEADERBOARD_NOTE",
    "REALMDataset",
    "REALMEvaluator",
    "MetricsCalculator",
    "REALMRunner",
]
