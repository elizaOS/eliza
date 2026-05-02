"""
Vending-Bench Reporting

Generates markdown reports and visualizations for benchmark results.
"""

from datetime import datetime

from elizaos_vending_bench.types import (
    LEADERBOARD_SCORES,
    LeaderboardComparison,
    VendingBenchMetrics,
    VendingBenchReport,
    VendingBenchResult,
)


class VendingBenchReporter:
    """Generates reports for Vending-Bench results."""

    def generate_report(self, report: VendingBenchReport) -> str:
        """
        Generate a comprehensive markdown report.

        Args:
            report: The benchmark report to format

        Returns:
            Markdown formatted report
        """
        sections = [
            self._header(report),
            self._executive_summary(report),
            self._metrics_section(report.metrics),
            self._leaderboard_section(report.leaderboard_comparison),
            self._detailed_results(report.results),
            self._coherence_analysis(report),
            self._recommendations(report.summary),
            self._methodology(),
            self._footer(report),
        ]

        return "\n\n".join(filter(None, sections))

    def _header(self, report: VendingBenchReport) -> str:
        """Generate report header."""
        return f"""# Vending-Bench Evaluation Report

**Generated:** {report.metadata.get("timestamp", datetime.now().isoformat())}
**Model:** {report.config.model_name}
**Version:** {report.metadata.get("version", "1.0.0")}

---"""

    def _executive_summary(self, report: VendingBenchReport) -> str:
        """Generate executive summary section."""
        summary = report.summary

        status_emoji = {
            "excellent": "🏆",
            "good": "✅",
            "moderate": "⚠️",
            "needs_improvement": "❌",
        }.get(str(summary.get("status", "moderate")), "📊")

        return f"""## Executive Summary {status_emoji}

| Metric | Value |
|--------|-------|
| **Best Net Worth** | {summary.get("best_net_worth", "N/A")} |
| **Average Net Worth** | {summary.get("avg_net_worth", "N/A")} |
| **Profitability Rate** | {summary.get("profitability_rate", "N/A")} |
| **Coherence Score** | {summary.get("coherence_score", "N/A")} |
| **Runs Completed** | {report.metadata.get("successful_runs", 0)}/{report.metadata.get("total_runs", 0)} |

### Key Findings

{chr(10).join(f"- {finding}" for finding in summary.get("key_findings", []))}"""

    def _metrics_section(self, metrics: VendingBenchMetrics) -> str:
        """Generate detailed metrics section."""
        return f"""## Performance Metrics

### Financial Performance

| Metric | Value |
|--------|-------|
| Average Net Worth | ${metrics.avg_net_worth:.2f} |
| Maximum Net Worth | ${metrics.max_net_worth:.2f} |
| Minimum Net Worth | ${metrics.min_net_worth:.2f} |
| Std Deviation | ${metrics.std_net_worth:.2f} |
| Median Net Worth | ${metrics.median_net_worth:.2f} |
| Average Profit | ${metrics.avg_profit:.2f} |

### Success Rates

| Metric | Value |
|--------|-------|
| Success Rate (Profitable) | {metrics.success_rate:.1%} |
| Profitability Rate | {metrics.profitability_rate:.1%} |

### Operational Metrics

| Metric | Value |
|--------|-------|
| Avg Items Sold | {metrics.avg_items_sold:.1f} |
| Avg Orders Placed | {metrics.avg_orders_placed:.1f} |
| Avg Stockout Days | {metrics.avg_stockout_days:.1f} |
| Avg Simulation Days | {metrics.avg_simulation_days:.1f} |

### Efficiency Metrics

| Metric | Value |
|--------|-------|
| Avg Tokens per Run | {metrics.avg_tokens_per_run:.0f} |
| Avg Tokens per Day | {metrics.avg_tokens_per_day:.0f} |
| Avg Latency per Action | {metrics.avg_latency_per_action_ms:.1f} ms |"""

    def _leaderboard_section(
        self,
        comparison: LeaderboardComparison | None,
    ) -> str:
        """Generate leaderboard comparison section."""
        if not comparison:
            return ""

        # Build comparison table
        rows = []
        our_row_added = False

        # Get sorted leaderboard
        sorted_entries = sorted(
            LEADERBOARD_SCORES.items(),
            key=lambda x: x[1].top_score,
            reverse=True,
        )

        rank = 1
        for _name, entry in sorted_entries:
            if not our_row_added and comparison.our_score >= entry.top_score:
                rows.append(
                    f"| **{rank}** | **ElizaOS (This Run)** | **${comparison.our_score:.2f}** | **← YOU ARE HERE** |"
                )
                rank += 1
                our_row_added = True

            rows.append(f"| {rank} | {entry.model_name} | ${entry.top_score:.2f} | |")
            rank += 1

        if not our_row_added:
            rows.append(
                f"| **{rank}** | **ElizaOS (This Run)** | **${comparison.our_score:.2f}** | **← YOU ARE HERE** |"
            )

        return f"""## Leaderboard Comparison

**Your Rank:** #{comparison.our_rank} of {comparison.total_entries}
**Percentile:** Top {100 - comparison.percentile:.0f}%

| Rank | Model | Top Score | Notes |
|------|-------|-----------|-------|
{chr(10).join(rows)}

### Comparison with Top Models

{chr(10).join(f"- vs **{name}**: {comp}" for name, score, comp in comparison.comparisons[:5])}"""

    def _detailed_results(self, results: list[VendingBenchResult]) -> str:
        """Generate detailed results table."""
        rows = []
        for r in results:
            status = "✓" if r.error is None and r.profit > 0 else ("⚠" if r.error is None else "✗")
            rows.append(
                f"| {r.run_id} | {status} | ${r.final_net_worth:.2f} | ${r.profit:.2f} | "
                f"{r.simulation_days} | {r.items_sold} | {len(r.coherence_errors)} |"
            )

        return f"""## Detailed Run Results

| Run ID | Status | Net Worth | Profit | Days | Items Sold | Errors |
|--------|--------|-----------|--------|------|------------|--------|
{chr(10).join(rows)}"""

    def _coherence_analysis(self, report: VendingBenchReport) -> str:
        """Generate coherence analysis section."""
        metrics = report.metrics

        # Score interpretation
        if metrics.coherence_score >= 0.9:
            interpretation = "Excellent - Agent maintains consistent decision-making"
        elif metrics.coherence_score >= 0.7:
            interpretation = "Good - Occasional inconsistencies but generally coherent"
        elif metrics.coherence_score >= 0.5:
            interpretation = "Moderate - Some coherence issues affecting performance"
        else:
            interpretation = "Poor - Significant coherence problems"

        # Error breakdown
        error_rows = []
        for error_type, count in sorted(
            metrics.error_breakdown.items(),
            key=lambda x: x[1],
            reverse=True,
        ):
            error_rows.append(f"| {error_type.value} | {count} |")

        return f"""## Coherence Analysis

**Overall Score:** {metrics.coherence_score:.1%}
**Interpretation:** {interpretation}
**Average Errors per Run:** {metrics.avg_coherence_errors:.1f}

### Error Breakdown

| Error Type | Count |
|------------|-------|
{chr(10).join(error_rows) if error_rows else "| No errors detected | 0 |"}

### Common Failure Modes

Based on the Vending-Bench paper, common failure modes include:
- **Misinterpreting delivery schedules** - Expecting orders before lead time
- **Forgetting placed orders** - Placing duplicate orders
- **Entering unproductive loops** - Repeating same ineffective actions
- **Price optimization errors** - Erratic or contradictory pricing
- **Inventory tracking mistakes** - Losing track of stock levels"""

    def _recommendations(self, summary: dict[str, str | list[str]]) -> str:
        """Generate recommendations section."""
        recommendations = summary.get("recommendations", [])
        if not recommendations:
            return ""

        items = "\n".join(f"1. {rec}" for rec in recommendations)

        return f"""## Recommendations

{items}"""

    def _methodology(self) -> str:
        """Generate methodology section."""
        return """## Methodology

### Benchmark Design

Vending-Bench evaluates LLM agents on long-term coherence in a simulated vending machine business:

- **Initial Capital:** $500
- **Vending Machine:** 4 rows × 3 columns (12 slots)
- **Products:** Mix of beverages, snacks, and healthy options
- **Suppliers:** 3 suppliers with different lead times and discounts
- **Simulation:** Up to 30 days of operations

### Evaluation Metrics

1. **Net Worth** = Cash on Hand + Cash in Machine + Inventory Value
2. **Coherence Score** = Based on detected decision-making errors
3. **Profitability** = Final net worth > initial capital

### Economic Model

- Price elasticity affects demand
- Weather and seasonal variations
- Weekend sales boost
- Supplier bulk discounts

### Reference

- Paper: https://arxiv.org/abs/2502.15840
- Leaderboard: https://andonlabs.com/evals/vending-bench"""

    def _footer(self, report: VendingBenchReport) -> str:
        """Generate report footer."""
        duration = report.metadata.get("duration_seconds", 0)
        return f"""---

*Report generated by ElizaOS Vending-Bench v{report.metadata.get("version", "1.0.0")}*
*Total benchmark duration: {duration:.1f} seconds*
*Timestamp: {report.metadata.get("timestamp", "N/A")}*"""
