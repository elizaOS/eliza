"""
MINT Benchmark Reporting

Generates a comprehensive Markdown report from MINT benchmark results.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from benchmarks.mint.types import (
    ConfigurationResult,
    LEADERBOARD_SCORES,
    MINTBenchmarkResults,
    MINTSubtask,
    PAPER_RESULTS_URL,
)


class MINTReporter:
    """Generate reports from MINT benchmark results."""

    def generate_report(self, results: MINTBenchmarkResults) -> str:
        sections = [
            self._header(results),
            self._summary(results),
            self._configuration_comparison(results),
            self._subtask_breakdown(results),
            self._ablation_analysis(results),
            self._leaderboard_section(results),
            self._detailed_metrics(results),
            self._recommendations(results),
            self._footer(results),
        ]
        return "\n\n".join(filter(None, sections))

    # ------------------------------------------------------------------
    def _header(self, results: MINTBenchmarkResults) -> str:
        metadata = results.metadata
        timestamp = metadata.get("timestamp", datetime.now().isoformat())
        return (
            "# MINT Benchmark Results\n\n"
            "## ElizaOS Python Runtime Evaluation\n\n"
            "**Benchmark**: MINT (Multi-turn Interaction with Tools and Language Feedback)\n"
            f"**Date**: {timestamp}\n"
            f"**Duration**: {metadata.get('duration_seconds', 0):.1f} seconds\n"
            f"**Total Tasks**: {metadata.get('total_tasks', 0)}\n\n"
            "---"
        )

    def _summary(self, results: MINTBenchmarkResults) -> str:
        summary = results.summary
        key = summary.get("key_findings", [])
        findings = "\n".join(f"- {f}" for f in key) if key else "- No findings"
        return (
            "## Executive Summary\n\n"
            f"**Status**: {str(summary.get('status', 'unknown')).replace('_', ' ').title()}\n"
            f"**Best Configuration**: {summary.get('best_configuration', 'N/A')}\n"
            f"**Best Success Rate**: {summary.get('best_success_rate', 'N/A')}\n\n"
            "### Key Findings\n\n"
            f"{findings}"
        )

    def _configuration_comparison(self, results: MINTBenchmarkResults) -> str:
        rows: list[str] = []

        def add_row(name: str, cr: Optional[ConfigurationResult]) -> None:
            if not cr:
                return
            m = cr.metrics
            rows.append(
                f"| {name} | {m.overall_success_rate:.1%} | "
                f"{m.passed_tasks}/{m.total_tasks} | "
                f"{m.turn_1_success_rate:.1%} | {m.turn_3_success_rate:.1%} | {m.turn_5_success_rate:.1%} |"
            )

        add_row("Baseline", results.baseline_results)
        add_row("Tools only", results.tools_only_results)
        add_row("Feedback only", results.feedback_only_results)
        add_row("Full", results.full_results)
        if not rows:
            return ""

        body = "\n".join(rows)
        return (
            "## Configuration Comparison\n\n"
            "| Configuration | Final SR | Passed | Turn-1 SR | Turn-3 SR | Turn-5 SR |\n"
            "|--------------|---------|--------|-----------|-----------|-----------|\n"
            f"{body}\n\n"
            "### Improvement\n\n"
            "| Metric | Value |\n"
            "|--------|-------|\n"
            f"| Tool Improvement | {results.comparison.get('tool_improvement', 0):+.1%} |\n"
            f"| Feedback Improvement | {results.comparison.get('feedback_improvement', 0):+.1%} |\n"
            f"| Combined Improvement | {results.comparison.get('combined_improvement', 0):+.1%} |\n"
            f"| Synergy | {results.comparison.get('synergy', 0):+.1%} |"
        )

    def _subtask_breakdown(self, results: MINTBenchmarkResults) -> str:
        canonical = results.full_results or results.baseline_results
        rows: list[str] = []
        for st in MINTSubtask:
            count = canonical.metrics.subtask_counts.get(st, 0)
            if count == 0:
                continue
            rate = canonical.metrics.subtask_success_rates.get(st, 0.0)
            st_results = [r for r in canonical.results if r.subtask == st]
            avg_turns = (
                sum(r.turns_used for r in st_results) / len(st_results)
                if st_results
                else 0.0
            )
            rows.append(
                f"| {st.value} | {rate:.1%} | {sum(1 for r in st_results if r.success)}/{count} | {avg_turns:.1f} |"
            )
        if not rows:
            return ""
        body = "\n".join(rows)
        return (
            "## Per-Subtask Breakdown\n\n"
            "| Subtask | Success Rate | Passed | Avg Turns |\n"
            "|---------|--------------|--------|-----------|\n"
            f"{body}"
        )

    def _ablation_analysis(self, results: MINTBenchmarkResults) -> str:
        if not results.tools_only_results and not results.feedback_only_results:
            return ""

        sections = ["## Ablation Study"]
        if results.tools_only_results:
            m = results.tools_only_results.metrics
            sections.append(
                "\n### Tool Effectiveness\n\n"
                f"- Tool usage rate: {m.tool_usage_rate:.1%}\n"
                f"- Avg tool uses (success / failure): {m.avg_tool_uses_success:.1f} / {m.avg_tool_uses_failure:.1f}\n"
                f"- Effectiveness: {m.tool_effectiveness:+.1%}"
            )
        if results.feedback_only_results:
            m = results.feedback_only_results.metrics
            sections.append(
                "\n### Feedback Effectiveness\n\n"
                f"- Feedback usage rate: {m.feedback_usage_rate:.1%}\n"
                f"- Avg feedback turns (success / failure): {m.avg_feedback_turns_success:.1f} / {m.avg_feedback_turns_failure:.1f}\n"
                f"- Effectiveness: {m.feedback_effectiveness:+.1%}"
            )
        if results.full_results:
            m = results.full_results.metrics
            sections.append(
                "\n### Multi-Turn Progression\n\n"
                "| Turn | Cumulative SR |\n"
                "|------|---------------|\n"
                f"| Turn 1 | {m.turn_1_success_rate:.1%} |\n"
                f"| Turn 2 | {m.turn_2_success_rate:.1%} |\n"
                f"| Turn 3 | {m.turn_3_success_rate:.1%} |\n"
                f"| Turn 4 | {m.turn_4_success_rate:.1%} |\n"
                f"| Turn 5 | {m.turn_5_success_rate:.1%} |\n\n"
                f"**Multi-turn gain**: {m.multi_turn_gain:+.1%} (Turn-5 SR − Turn-1 SR)."
            )
        return "\n".join(sections)

    def _leaderboard_section(self, results: MINTBenchmarkResults) -> str:
        canonical = results.full_results or results.baseline_results
        m = canonical.metrics
        if not LEADERBOARD_SCORES:
            return (
                "## Paper Comparison\n\n"
                f"Compare these per-subtask numbers to Table 2 / Table 3 of "
                f"the MINT paper: {PAPER_RESULTS_URL}\n\n"
                f"- Turn-1 SR: {m.turn_1_success_rate:.1%}\n"
                f"- Turn-3 SR: {m.turn_3_success_rate:.1%}\n"
                f"- Turn-5 SR: {m.turn_5_success_rate:.1%}\n"
                f"- Overall (final): {m.overall_success_rate:.1%}"
            )

        rows: list[str] = []
        for model_name, scores in LEADERBOARD_SCORES.items():
            lb_overall = scores.get("overall", 0.0)
            diff = m.overall_success_rate - lb_overall
            rows.append(f"| {model_name} | {lb_overall:.1%} | {diff:+.1%} |")
        body = "\n".join(rows)
        return (
            "## Leaderboard Comparison\n\n"
            f"**Our overall**: {m.overall_success_rate:.1%}\n\n"
            "| Model | Reported | vs. Ours |\n"
            "|-------|---------|----------|\n"
            f"{body}\n\n"
            f"*Reference: {PAPER_RESULTS_URL}*"
        )

    def _detailed_metrics(self, results: MINTBenchmarkResults) -> str:
        canonical = results.full_results or results.baseline_results
        m = canonical.metrics
        return (
            "## Detailed Metrics\n\n"
            "| Metric | Value |\n"
            "|--------|-------|\n"
            f"| Total tasks | {m.total_tasks} |\n"
            f"| Passed | {m.passed_tasks} |\n"
            f"| Failed | {m.failed_tasks} |\n"
            f"| Overall success rate | {m.overall_success_rate:.1%} |\n"
            f"| Avg latency | {m.avg_latency_ms:.0f}ms |\n"
            f"| Total duration | {m.total_duration_ms / 1000:.1f}s |\n"
            f"| Avg tokens/task | {m.avg_tokens_per_task:.0f} |\n\n"
            "### Turn Analysis\n\n"
            "| Metric | Value |\n"
            "|--------|-------|\n"
            f"| Avg turns (success) | {m.avg_turns_to_success:.2f} |\n"
            f"| Avg turns (failure) | {m.avg_turns_to_failure:.2f} |\n"
            f"| Turn efficiency | {m.turn_efficiency:.3f} |\n"
            f"| Multi-turn gain | {m.multi_turn_gain:+.1%} |"
        )

    def _recommendations(self, results: MINTBenchmarkResults) -> str:
        recs = results.summary.get("recommendations", [])
        if not recs:
            return ""
        body = "\n".join(f"{i + 1}. {r}" for i, r in enumerate(recs))
        return f"## Recommendations\n\n{body}"

    def _footer(self, results: MINTBenchmarkResults) -> str:
        metadata = results.metadata
        timestamp = metadata.get("timestamp", datetime.now().isoformat())
        cfg = metadata.get("config", {}) if isinstance(metadata, dict) else {}
        return (
            "---\n\n"
            "## Methodology\n\n"
            "This benchmark follows the MINT evaluation protocol from "
            "Wang et al., ICLR 2024 (arXiv:2309.10691). The 8 subtasks "
            "are grouped into 3 task types:\n\n"
            "- **Reasoning**: gsm8k, math, theoremqa, mmlu, hotpotqa\n"
            "- **Code generation**: humaneval, mbpp\n"
            "- **Decision making**: alfworld (lazy)\n\n"
            "**Configuration:**\n"
            f"- Max turns per task: {cfg.get('max_turns', 5)}\n"
            f"- Tool execution: {'Docker sandbox' if cfg.get('use_docker') else 'Local subprocess'}\n"
            f"- Feedback mode: {cfg.get('feedback_mode', 'templated')}\n"
            f"- Ablation: {'enabled' if cfg.get('run_ablation') else 'disabled'}\n\n"
            "---\n\n"
            f"*Generated by ElizaOS MINT benchmark runner — {timestamp}*"
        )


def format_percentage(value: float) -> str:
    return f"{value * 100:.1f}%"


def format_duration(ms: float) -> str:
    if ms < 1000:
        return f"{ms:.0f}ms"
    if ms < 60000:
        return f"{ms / 1000:.1f}s"
    return f"{ms / 60000:.1f}m"
