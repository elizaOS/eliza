"""
MINT Benchmark Reporting

Generates comprehensive reports from MINT benchmark results.
"""

from datetime import datetime
from typing import Optional

from benchmarks.mint.types import (
    MINTCategory,
    MINTBenchmarkResults,
    ConfigurationResult,
    LEADERBOARD_SCORES,
)


class MINTReporter:
    """Generate reports from MINT benchmark results."""

    def generate_report(self, results: MINTBenchmarkResults) -> str:
        """
        Generate a comprehensive markdown report.

        Args:
            results: Complete benchmark results

        Returns:
            Markdown report string
        """
        sections = [
            self._generate_header(results),
            self._generate_summary(results),
            self._generate_configuration_comparison(results),
            self._generate_category_breakdown(results),
            self._generate_ablation_analysis(results),
            self._generate_leaderboard_comparison(results),
            self._generate_detailed_metrics(results),
            self._generate_recommendations(results),
            self._generate_footer(results),
        ]

        return "\n\n".join(filter(None, sections))

    def _generate_header(self, results: MINTBenchmarkResults) -> str:
        """Generate report header."""
        metadata = results.metadata
        timestamp = metadata.get("timestamp", datetime.now().isoformat())

        return f"""# MINT Benchmark Results

## ElizaOS Python Runtime Evaluation

**Benchmark**: MINT (Multi-turn Interaction with Tools and Language Feedback)
**Date**: {timestamp}
**Duration**: {metadata.get('duration_seconds', 0):.1f} seconds
**Total Tasks**: {metadata.get('total_tasks', 0)}

---"""

    def _generate_summary(self, results: MINTBenchmarkResults) -> str:
        """Generate executive summary."""
        summary = results.summary

        status_emoji = {
            "excellent": "🌟",
            "good": "✅",
            "moderate": "⚠️",
            "needs_improvement": "❌",
        }.get(str(summary.get("status", "")), "📊")

        key_findings = summary.get("key_findings", [])
        findings_list = "\n".join(f"- {f}" for f in key_findings) if key_findings else "- No findings"

        return f"""## Executive Summary

{status_emoji} **Status**: {str(summary.get("status", "unknown")).replace("_", " ").title()}

**Best Configuration**: {summary.get("best_configuration", "N/A")}
**Best Success Rate**: {summary.get("best_success_rate", "N/A")}

### Key Findings

{findings_list}"""

    def _generate_configuration_comparison(self, results: MINTBenchmarkResults) -> str:
        """Generate configuration comparison table."""
        rows = []

        def add_row(name: str, cr: Optional[ConfigurationResult]) -> None:
            if cr:
                m = cr.metrics
                rows.append(
                    f"| {name} | {m.overall_success_rate:.1%} | "
                    f"{m.passed_tasks}/{m.total_tasks} | "
                    f"{m.avg_turns_to_success:.1f} | "
                    f"{m.avg_latency_ms:.0f}ms |"
                )

        add_row("Baseline (no tools/feedback)", results.baseline_results)
        add_row("Tools Only", results.tools_only_results)
        add_row("Feedback Only", results.feedback_only_results)
        add_row("Full (tools + feedback)", results.full_results)

        if not rows:
            return ""

        rows_str = "\n".join(rows)

        return f"""## Configuration Comparison

| Configuration | Success Rate | Passed | Avg Turns | Avg Latency |
|--------------|--------------|--------|-----------|-------------|
{rows_str}

### Improvement Analysis

| Metric | Value |
|--------|-------|
| Tool Improvement | {results.comparison.get('tool_improvement', 0):+.1%} |
| Feedback Improvement | {results.comparison.get('feedback_improvement', 0):+.1%} |
| Combined Improvement | {results.comparison.get('combined_improvement', 0):+.1%} |
| Synergy Effect | {results.comparison.get('synergy', 0):+.1%} |"""

    def _generate_category_breakdown(self, results: MINTBenchmarkResults) -> str:
        """Generate per-category breakdown."""
        # Use full results if available, otherwise baseline
        config = results.full_results or results.baseline_results

        rows = []
        for cat in MINTCategory:
            rate = config.metrics.category_success_rates.get(cat, 0)
            count = config.metrics.category_counts.get(cat, 0)

            if count > 0:
                # Get category-specific task results
                cat_results = [r for r in config.results if r.category == cat]
                passed = sum(1 for r in cat_results if r.success)
                avg_turns = (
                    sum(r.turns_used for r in cat_results) / len(cat_results)
                    if cat_results else 0
                )

                status = "✅" if rate >= 0.7 else "⚠️" if rate >= 0.4 else "❌"
                rows.append(
                    f"| {status} {cat.value.replace('_', ' ').title()} | "
                    f"{rate:.1%} | {passed}/{count} | {avg_turns:.1f} |"
                )

        if not rows:
            return ""

        rows_str = "\n".join(rows)

        return f"""## Category Breakdown

| Category | Success Rate | Passed | Avg Turns |
|----------|--------------|--------|-----------|
{rows_str}"""

    def _generate_ablation_analysis(self, results: MINTBenchmarkResults) -> str:
        """Generate ablation study analysis."""
        if not results.tools_only_results and not results.feedback_only_results:
            return ""

        sections = ["## Ablation Study Analysis"]

        # Tool effectiveness
        if results.tools_only_results:
            m = results.tools_only_results.metrics
            sections.append(f"""
### Tool Effectiveness

- **Tool Usage Rate**: {m.tool_usage_rate:.1%}
- **Avg Tool Uses (Success)**: {m.avg_tool_uses_success:.1f}
- **Avg Tool Uses (Failure)**: {m.avg_tool_uses_failure:.1f}
- **Tool Effectiveness**: {m.tool_effectiveness:+.1%}

Tool use {'improves' if m.tool_effectiveness > 0 else 'decreases'} success rate by {abs(m.tool_effectiveness):.1%}.""")

        # Feedback effectiveness
        if results.feedback_only_results:
            m = results.feedback_only_results.metrics
            sections.append(f"""
### Feedback Effectiveness

- **Feedback Usage Rate**: {m.feedback_usage_rate:.1%}
- **Avg Feedback Turns (Success)**: {m.avg_feedback_turns_success:.1f}
- **Avg Feedback Turns (Failure)**: {m.avg_feedback_turns_failure:.1f}
- **Feedback Effectiveness**: {m.feedback_effectiveness:+.1%}

Feedback {'improves' if m.feedback_effectiveness > 0 else 'decreases'} success rate by {abs(m.feedback_effectiveness):.1%}.""")

        # Multi-turn analysis
        if results.full_results:
            m = results.full_results.metrics
            sections.append(f"""
### Multi-Turn Progression

| Turn | Cumulative Success Rate |
|------|------------------------|
| Turn 1 | {m.turn_1_success_rate:.1%} |
| Turn 3 | {m.turn_3_success_rate:.1%} |
| Turn 5 | {m.turn_5_success_rate:.1%} |

**Multi-turn Gain**: {m.multi_turn_gain:+.1%} improvement from turn 1 to turn 5.""")

        return "\n".join(sections)

    def _generate_leaderboard_comparison(self, results: MINTBenchmarkResults) -> str:
        """Generate comparison with published leaderboard scores."""
        config = results.full_results or results.baseline_results

        our_overall = config.metrics.overall_success_rate

        rows = []
        for model_name, scores in LEADERBOARD_SCORES.items():
            lb_overall = scores.get("overall", 0)
            diff = our_overall - lb_overall
            diff_str = f"{diff:+.1%}"

            rows.append(f"| {model_name} | {lb_overall:.1%} | {diff_str} |")

        rows_str = "\n".join(rows)

        return f"""## Leaderboard Comparison

**ElizaOS Overall Score**: {our_overall:.1%}

| Model | Published Score | vs ElizaOS |
|-------|----------------|------------|
{rows_str}

*Note: Leaderboard scores are from the original MINT paper (ICLR 2024).*"""

    def _generate_detailed_metrics(self, results: MINTBenchmarkResults) -> str:
        """Generate detailed metrics section."""
        config = results.full_results or results.baseline_results
        m = config.metrics

        return f"""## Detailed Metrics

### Performance Metrics

| Metric | Value |
|--------|-------|
| Total Tasks | {m.total_tasks} |
| Passed Tasks | {m.passed_tasks} |
| Failed Tasks | {m.failed_tasks} |
| Overall Success Rate | {m.overall_success_rate:.1%} |
| Average Latency | {m.avg_latency_ms:.0f}ms |
| Total Duration | {m.total_duration_ms / 1000:.1f}s |
| Average Tokens/Task | {m.avg_tokens_per_task:.0f} |

### Turn Analysis

| Metric | Value |
|--------|-------|
| Avg Turns to Success | {m.avg_turns_to_success:.2f} |
| Avg Turns to Failure | {m.avg_turns_to_failure:.2f} |
| Turn Efficiency | {m.turn_efficiency:.3f} |
| Multi-turn Gain | {m.multi_turn_gain:+.1%} |"""

    def _generate_recommendations(self, results: MINTBenchmarkResults) -> str:
        """Generate recommendations section."""
        recommendations = results.summary.get("recommendations", [])
        if not recommendations:
            return ""

        rec_list = "\n".join(f"{i + 1}. {r}" for i, r in enumerate(recommendations))

        return f"""## Recommendations

{rec_list}"""

    def _generate_footer(self, results: MINTBenchmarkResults) -> str:
        """Generate report footer."""
        metadata = results.metadata
        timestamp = metadata.get("timestamp", datetime.now().isoformat())

        return f"""---

## Methodology

This benchmark follows the MINT evaluation protocol from the ICLR 2024 paper:
"MINT: Evaluating LLMs in Multi-turn Interaction with Tools and Language Feedback"

**Categories Evaluated**:
- Reasoning: Mathematical and logical problems
- Coding: Programming challenges
- Decision Making: Sequential decision tasks
- Information Seeking: Knowledge retrieval tasks

**Configuration**:
- Max turns per task: {metadata.get('config', {}).get('max_turns', 5)}
- Tool execution: {'Docker sandboxed' if metadata.get('config', {}).get('use_docker', True) else 'Local'}
- Ablation study: {'Enabled' if metadata.get('config', {}).get('run_ablation', False) else 'Disabled'}

---

*Generated by ElizaOS MINT Benchmark Runner*
*Report generated: {timestamp}*"""


def format_percentage(value: float) -> str:
    """Format a float as a percentage string."""
    return f"{value * 100:.1f}%"


def format_duration(ms: float) -> str:
    """Format milliseconds as a readable duration."""
    if ms < 1000:
        return f"{ms:.0f}ms"
    elif ms < 60000:
        return f"{ms / 1000:.1f}s"
    else:
        return f"{ms / 60000:.1f}m"
