"""LifeOpsBench — multi-turn life-assistant tool-use benchmark.

Public API:
    LifeOpsBenchRunner: orchestrates benchmark runs across scenarios.
    Scenario, Action, MessageTurn, Persona, FirstQuestionFallback: scenario types.
    BenchmarkResult, ScenarioResult, TurnResult: result types.
    Domain, ScenarioMode: enums.
"""

from __future__ import annotations

from .types import (
    Action,
    BenchmarkResult,
    Domain,
    FirstQuestionFallback,
    MessageTurn,
    Persona,
    Scenario,
    ScenarioMode,
    ScenarioResult,
    TurnResult,
    attach_usage_cache_fields,
    compute_cache_hit_pct,
)


def __getattr__(name: str):
    if name == "LifeOpsBenchRunner":
        from .runner import LifeOpsBenchRunner

        return LifeOpsBenchRunner
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "Action",
    "BenchmarkResult",
    "Domain",
    "FirstQuestionFallback",
    "LifeOpsBenchRunner",
    "MessageTurn",
    "Persona",
    "Scenario",
    "ScenarioMode",
    "ScenarioResult",
    "TurnResult",
    "attach_usage_cache_fields",
    "compute_cache_hit_pct",
]
