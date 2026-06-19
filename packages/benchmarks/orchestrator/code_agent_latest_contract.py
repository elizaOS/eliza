"""Shared contract for code-agent latest benchmark snapshots."""

from __future__ import annotations

import math
from typing import Any

CODE_AGENT_LATEST_AGENT = "elizaos_vs_opencode"

CODE_AGENT_LATEST_REQUIRED_PROVENANCE_FIELDS: tuple[str, ...] = (
    "target_result_path",
    "baseline_result_path",
    "target_command_path",
    "baseline_command_path",
    "target_trajectory_dir",
    "baseline_trajectory_dir",
)

CODE_AGENT_LATEST_REQUIRED_NUMERIC_FIELDS: tuple[str, ...] = (
    "target_right",
    "target_wrong",
    "target_total",
    "baseline_right",
    "baseline_wrong",
    "baseline_total",
    "target_input_tokens",
    "target_output_tokens",
    "target_total_tokens",
    "target_cached_token_percent",
    "target_llm_call_count",
    "baseline_input_tokens",
    "baseline_output_tokens",
    "baseline_total_tokens",
    "baseline_cached_token_percent",
    "baseline_llm_call_count",
    "accuracy_delta",
    "input_token_delta",
    "output_token_delta",
    "total_token_delta",
    "llm_call_delta",
    "cached_token_percent_delta",
)

CODE_AGENT_LATEST_REQUIRED_TRUE_FIELDS: tuple[str, ...] = (
    "coverage_gate_ok",
    "benchmark_gate_ok",
    "required_stats_gate_ok",
    "efficiency_gate_ok",
    "quality_guardrail_gate_ok",
    "trajectory_review_gate_ok",
    "live_report_gate_ok",
    "report_gate_ok",
    "release_readiness_ok",
)

CODE_AGENT_LATEST_ACCEPTABLE_COMPARISON_STATUSES: frozenset[str] = frozenset(
    {"superior", "comparable"}
)


def expected_code_agent_comparison_status(payload: dict[str, Any]) -> str | None:
    target_accuracy = code_agent_accuracy_for_status(payload, "target")
    baseline_accuracy = code_agent_accuracy_for_status(payload, "baseline")
    if target_accuracy is None or baseline_accuracy is None:
        return None
    if target_accuracy <= 0 and baseline_accuracy <= 0:
        return "weak"
    if target_accuracy + 1e-9 < baseline_accuracy:
        return "inferior"
    if target_accuracy > baseline_accuracy + 1e-9:
        return "superior"
    return "comparable"


def code_agent_accuracy_for_status(
    payload: dict[str, Any],
    prefix: str,
) -> float | None:
    explicit = payload.get(f"{prefix}_accuracy")
    if _is_finite_number(explicit):
        return float(explicit)
    right = payload.get(f"{prefix}_right")
    total = payload.get(f"{prefix}_total")
    if _is_finite_number(right) and _is_finite_number(total) and float(total) > 0:
        return float(right) / float(total)
    return None


def _is_finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )
