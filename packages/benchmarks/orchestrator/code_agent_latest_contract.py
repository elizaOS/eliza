"""Shared contract for code-agent latest benchmark snapshots."""

from __future__ import annotations

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
