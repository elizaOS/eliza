"""
GAIA Benchmark Metrics and Leaderboard Comparison

Calculates comprehensive metrics from benchmark results and
compares with published leaderboard scores.
"""

import logging

from elizaos_gaia.types import (
    LEADERBOARD_SCORES,
    GAIALevel,
    GAIAMetrics,
    GAIAResult,
    LeaderboardComparison,
    ToolType,
)

logger = logging.getLogger(__name__)


class MetricsCalculator:
    """Calculate comprehensive metrics from GAIA benchmark results."""

    def calculate(self, results: list[GAIAResult]) -> GAIAMetrics:
        """
        Calculate metrics from benchmark results.

        Args:
            results: List of GAIAResult objects

        Returns:
            GAIAMetrics with comprehensive statistics
        """
        if not results:
            return GAIAMetrics(
                overall_accuracy=0.0,
                total_questions=0,
                correct_answers=0,
                incorrect_answers=0,
                errors=0,
            )

        # Count totals
        total = len(results)
        correct = sum(1 for r in results if r.is_correct)
        errors = sum(1 for r in results if r.error)

        # Per-level breakdown
        level_counts: dict[GAIALevel, int] = {}
        level_correct: dict[GAIALevel, int] = {}
        level_accuracy: dict[GAIALevel, float] = {}

        for level in GAIALevel:
            level_results = [r for r in results if r.level == level]
            count = len(level_results)
            level_counts[level] = count
            correct_count = sum(1 for r in level_results if r.is_correct)
            level_correct[level] = correct_count
            level_accuracy[level] = correct_count / count if count > 0 else 0.0

        # Tool usage analysis
        tool_usage: dict[ToolType, int] = {}
        tool_success: dict[ToolType, int] = {}
        tool_total: dict[ToolType, int] = {}
        total_tools_used = 0

        for result in results:
            for tool in result.tools_used:
                tool_usage[tool] = tool_usage.get(tool, 0) + 1
                total_tools_used += 1

                # Track success rate for each tool
                if tool not in tool_total:
                    tool_total[tool] = 0
                    tool_success[tool] = 0
                tool_total[tool] += 1
                if result.is_correct:
                    tool_success[tool] = tool_success.get(tool, 0) + 1

        tool_success_rate: dict[ToolType, float] = {}
        for tool in tool_total:
            tool_success_rate[tool] = (
                tool_success.get(tool, 0) / tool_total[tool]
                if tool_total[tool] > 0 else 0.0
            )

        # Performance metrics
        total_latency = sum(r.latency_ms for r in results)
        total_tokens = sum(r.token_usage for r in results)
        total_steps = sum(len(r.steps_taken) for r in results)

        # Error categorization
        error_categories: dict[str, int] = {}
        for result in results:
            if result.error:
                # Categorize errors
                error = result.error.lower()
                if "timeout" in error:
                    category = "timeout"
                elif "api" in error or "rate" in error:
                    category = "api_error"
                elif "tool" in error:
                    category = "tool_error"
                else:
                    category = "other"
                error_categories[category] = error_categories.get(category, 0) + 1

        return GAIAMetrics(
            overall_accuracy=correct / total if total > 0 else 0.0,
            total_questions=total,
            correct_answers=correct,
            incorrect_answers=total - correct - errors,
            errors=errors,
            level_accuracy=level_accuracy,
            level_counts=level_counts,
            level_correct=level_correct,
            tool_usage=tool_usage,
            tool_success_rate=tool_success_rate,
            avg_tools_per_question=total_tools_used / total if total > 0 else 0.0,
            avg_steps=total_steps / total if total > 0 else 0.0,
            avg_latency_ms=total_latency / total if total > 0 else 0.0,
            avg_tokens_per_question=total_tokens / total if total > 0 else 0.0,
            total_tokens=total_tokens,
            total_duration_ms=total_latency,
            error_rate=errors / total if total > 0 else 0.0,
            error_categories=error_categories,
        )

    def compare_with_leaderboard(
        self,
        metrics: GAIAMetrics,
        leaderboard: dict[str, dict[str, float]] | None = None,
    ) -> LeaderboardComparison:
        """
        Compare metrics with published leaderboard scores.

        Args:
            metrics: Calculated metrics from benchmark
            leaderboard: Optional custom leaderboard (defaults to LEADERBOARD_SCORES)

        Returns:
            LeaderboardComparison with rankings
        """
        if leaderboard is None:
            leaderboard = LEADERBOARD_SCORES

        our_score = metrics.overall_accuracy
        our_level_scores = {
            GAIALevel.LEVEL_1: metrics.level_accuracy.get(GAIALevel.LEVEL_1, 0.0),
            GAIALevel.LEVEL_2: metrics.level_accuracy.get(GAIALevel.LEVEL_2, 0.0),
            GAIALevel.LEVEL_3: metrics.level_accuracy.get(GAIALevel.LEVEL_3, 0.0),
        }

        # Calculate rank
        all_scores = sorted(
            [entry["overall"] for entry in leaderboard.values()],
            reverse=True,
        )

        rank = 1
        for score in all_scores:
            if our_score < score:
                rank += 1

        total_entries = len(leaderboard)
        percentile = ((total_entries - rank + 1) / total_entries) * 100

        # Build comparison dict with our score added
        comparison = {
            "ElizaOS Agent": {
                "level_1": our_level_scores[GAIALevel.LEVEL_1],
                "level_2": our_level_scores[GAIALevel.LEVEL_2],
                "level_3": our_level_scores[GAIALevel.LEVEL_3],
                "overall": our_score,
            },
            **dict(leaderboard.items()),
        }

        return LeaderboardComparison(
            our_score=our_score,
            our_level_scores=our_level_scores,
            rank=rank,
            total_entries=total_entries + 1,  # Include our entry
            comparison=comparison,
            percentile=percentile,
        )

    def generate_analysis(
        self,
        metrics: GAIAMetrics,
        comparison: LeaderboardComparison | None = None,
    ) -> dict[str, list[str]]:
        """
        Generate analysis summary from metrics.

        Args:
            metrics: Calculated metrics
            comparison: Optional leaderboard comparison

        Returns:
            Dictionary with key findings, strengths, weaknesses, recommendations
        """
        findings: list[str] = []
        strengths: list[str] = []
        weaknesses: list[str] = []
        recommendations: list[str] = []

        # Overall performance analysis
        if metrics.overall_accuracy >= 0.5:
            findings.append(
                f"Strong overall performance: {metrics.overall_accuracy:.1%} accuracy"
            )
        elif metrics.overall_accuracy >= 0.3:
            findings.append(
                f"Moderate performance: {metrics.overall_accuracy:.1%} accuracy"
            )
        else:
            findings.append(
                f"Low performance: {metrics.overall_accuracy:.1%} accuracy"
            )

        # Level analysis
        for level in GAIALevel:
            acc = metrics.level_accuracy.get(level, 0)
            count = metrics.level_counts.get(level, 0)

            if count > 0:
                if acc >= 0.6:
                    strengths.append(
                        f"Level {level.value}: {acc:.1%} accuracy ({count} questions)"
                    )
                elif acc < 0.3:
                    weaknesses.append(
                        f"Level {level.value}: Only {acc:.1%} accuracy"
                    )

        # Tool usage analysis
        if metrics.avg_tools_per_question > 2:
            findings.append(
                f"Heavy tool use: {metrics.avg_tools_per_question:.1f} tools/question"
            )

        for tool, success_rate in metrics.tool_success_rate.items():
            usage = metrics.tool_usage.get(tool, 0)
            if usage >= 5:  # Only analyze tools with significant usage
                if success_rate >= 0.6:
                    strengths.append(
                        f"{tool.value}: {success_rate:.1%} success rate ({usage} uses)"
                    )
                elif success_rate < 0.4:
                    weaknesses.append(
                        f"{tool.value}: Low success rate ({success_rate:.1%})"
                    )
                    recommendations.append(
                        f"Improve {tool.value} tool usage strategy"
                    )

        # Error analysis
        if metrics.error_rate > 0.1:
            weaknesses.append(
                f"High error rate: {metrics.error_rate:.1%} of questions had errors"
            )
            recommendations.append("Investigate and reduce error sources")

        for category, count in metrics.error_categories.items():
            if count >= 3:
                recommendations.append(
                    f"Address {category} errors ({count} occurrences)"
                )

        # Performance analysis
        if metrics.avg_latency_ms > 60000:  # 1 minute
            weaknesses.append(
                f"Slow execution: {metrics.avg_latency_ms/1000:.0f}s average"
            )
            recommendations.append("Optimize for faster response times")
        elif metrics.avg_latency_ms < 10000:  # 10 seconds
            strengths.append(
                f"Fast execution: {metrics.avg_latency_ms/1000:.1f}s average"
            )

        # Leaderboard context
        if comparison:
            findings.append(
                f"Leaderboard rank: #{comparison.rank} of {comparison.total_entries}"
            )
            findings.append(f"Percentile: {comparison.percentile:.0f}th")

            if comparison.our_score > LEADERBOARD_SCORES.get("GPT-4 + Plugins (baseline)", {}).get("overall", 0.15):
                strengths.append("Outperforms GPT-4 + Plugins baseline")

            if comparison.our_score >= 0.38:  # Magentic-1 level
                strengths.append("Competitive with state-of-the-art agents")

        return {
            "key_findings": findings,
            "strengths": strengths,
            "weaknesses": weaknesses,
            "recommendations": recommendations,
        }
