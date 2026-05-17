"""Pass^k and aggregate scoring utilities.

The Pass^k metric mirrors tau-bench's definition: a task counts as
passed at k iff ALL k trials succeeded. Pass@1 is the special case k=1.
"""

from __future__ import annotations

from collections import defaultdict
from statistics import mean
from typing import Iterable

from .types import (
    Suite,
    VoiceBenchmarkReport,
    VoiceTaskResult,
)


def pass_at_k(results: Iterable[VoiceTaskResult], k: int) -> float:
    """Fraction of unique tasks that passed in all of their first k trials."""
    if k <= 0:
        raise ValueError("k must be >= 1")
    by_task: dict[str, list[VoiceTaskResult]] = defaultdict(list)
    for r in results:
        by_task[r.task_id].append(r)

    eligible = 0
    passed = 0
    for trials in by_task.values():
        if len(trials) < k:
            continue
        eligible += 1
        if all(t.passed for t in trials[:k]):
            passed += 1
    if eligible == 0:
        return 0.0
    return passed / eligible


def per_suite_pass_at_1(results: Iterable[VoiceTaskResult]) -> dict[str, float]:
    """Pass@1 per suite name."""
    bucket: dict[Suite, list[VoiceTaskResult]] = defaultdict(list)
    for r in results:
        bucket[r.suite].append(r)
    out: dict[str, float] = {}
    for suite, trials in bucket.items():
        if not trials:
            continue
        out[suite.value] = sum(1 for t in trials if t.passed) / len(trials)
    return out


def compile_report(
    *,
    tasks: list[VoiceTaskResult],
    model_name: str,
    judge_model_name: str,
    timestamp: str,
    seeds: int,
    k_values: tuple[int, ...] = (1, 2, 4),
) -> VoiceBenchmarkReport:
    """Build the aggregate report from per-task results."""
    coherence_scores = [
        t.coherence_score for t in tasks if t.coherence_score is not None
    ]
    safety_scores = [t.safety_score for t in tasks if t.safety_score is not None]
    tool_scores = [t.tool_selection_score for t in tasks]
    param_scores = [t.parameter_match_score for t in tasks]
    latencies = [t.latency_ms for t in tasks]

    pak: dict[int, float] = {}
    for k in k_values:
        pak[k] = pass_at_k(tasks, k)

    return VoiceBenchmarkReport(
        tasks=tasks,
        pass_at_1=pak.get(1, 0.0),
        pass_at_k=pak,
        per_suite_pass_at_1=per_suite_pass_at_1(tasks),
        mean_tool_selection=mean(tool_scores) if tool_scores else 0.0,
        mean_parameter_match=mean(param_scores) if param_scores else 0.0,
        mean_coherence=mean(coherence_scores) if coherence_scores else 0.0,
        mean_safety=mean(safety_scores) if safety_scores else 0.0,
        model_name=model_name,
        judge_model_name=judge_model_name,
        timestamp=timestamp,
        seeds=seeds,
        total_latency_ms=sum(latencies),
    )
