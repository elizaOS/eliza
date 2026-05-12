"""
MINT Metrics Calculator

Calculates comprehensive metrics from MINT benchmark results.
"""

import logging
from typing import Optional

from benchmarks.mint.types import (
    MINTCategory,
    MINTMetrics,
    MINTResult,
    ConfigurationResult,
    LEADERBOARD_SCORES,
)

logger = logging.getLogger(__name__)


class MetricsCalculator:
    """Calculate comprehensive MINT benchmark metrics."""

    def calculate(self, results: list[MINTResult]) -> MINTMetrics:
        """
        Calculate comprehensive metrics from results.

        Args:
            results: List of evaluation results

        Returns:
            MINTMetrics with all calculated metrics
        """
        if not results:
            return MINTMetrics(
                overall_success_rate=0.0,
                total_tasks=0,
                passed_tasks=0,
                failed_tasks=0,
            )

        total = len(results)
        passed = sum(1 for r in results if r.success)
        failed = total - passed

        # Category breakdown
        category_success_rates: dict[MINTCategory, float] = {}
        category_counts: dict[MINTCategory, int] = {}

        for cat in MINTCategory:
            cat_results = [r for r in results if r.category == cat]
            if cat_results:
                cat_passed = sum(1 for r in cat_results if r.success)
                category_success_rates[cat] = cat_passed / len(cat_results)
                category_counts[cat] = len(cat_results)

        # Success/failure analysis
        successful = [r for r in results if r.success]
        failed_results = [r for r in results if not r.success]

        avg_turns_success = (
            sum(r.turns_used for r in successful) / len(successful)
            if successful else 0.0
        )
        avg_turns_failure = (
            sum(r.turns_used for r in failed_results) / len(failed_results)
            if failed_results else 0.0
        )

        # Tool analysis
        with_tools = [r for r in results if r.tool_uses > 0]
        without_tools = [r for r in results if r.tool_uses == 0]

        tool_usage_rate = len(with_tools) / total if total > 0 else 0.0

        tool_success_rate = (
            sum(1 for r in with_tools if r.success) / len(with_tools)
            if with_tools else 0.0
        )
        no_tool_success_rate = (
            sum(1 for r in without_tools if r.success) / len(without_tools)
            if without_tools else 0.0
        )
        tool_effectiveness = tool_success_rate - no_tool_success_rate

        avg_tool_uses_success = (
            sum(r.tool_uses for r in successful) / len(successful)
            if successful else 0.0
        )
        avg_tool_uses_failure = (
            sum(r.tool_uses for r in failed_results) / len(failed_results)
            if failed_results else 0.0
        )

        # Feedback analysis
        with_feedback = [r for r in results if r.feedback_turns > 0]
        without_feedback = [r for r in results if r.feedback_turns == 0]

        feedback_usage_rate = len(with_feedback) / total if total > 0 else 0.0

        feedback_success_rate = (
            sum(1 for r in with_feedback if r.success) / len(with_feedback)
            if with_feedback else 0.0
        )
        no_feedback_success_rate = (
            sum(1 for r in without_feedback if r.success) / len(without_feedback)
            if without_feedback else 0.0
        )
        feedback_effectiveness = feedback_success_rate - no_feedback_success_rate

        avg_feedback_success = (
            sum(r.feedback_turns for r in successful) / len(successful)
            if successful else 0.0
        )
        avg_feedback_failure = (
            sum(r.feedback_turns for r in failed_results) / len(failed_results)
            if failed_results else 0.0
        )

        # Multi-turn analysis
        turn_1_success = sum(
            1 for r in results if r.success and r.turns_used == 1
        ) / total if total > 0 else 0.0

        turn_3_results = [r for r in results if r.turns_used <= 3]
        turn_3_success = (
            sum(1 for r in turn_3_results if r.success) / len(turn_3_results)
            if turn_3_results else 0.0
        )

        turn_5_results = [r for r in results if r.turns_used <= 5]
        turn_5_success = (
            sum(1 for r in turn_5_results if r.success) / len(turn_5_results)
            if turn_5_results else 0.0
        )

        # Multi-turn gain = improvement from turn 1 to turn 5
        multi_turn_gain = turn_5_success - turn_1_success

        # Performance metrics
        avg_latency = sum(r.latency_ms for r in results) / total
        avg_tokens = sum(r.token_usage for r in results) / total
        total_tokens = sum(r.token_usage for r in results)
        total_duration = sum(r.latency_ms for r in results)

        # Turn efficiency
        overall_success_rate = passed / total if total > 0 else 0.0
        avg_turns = sum(r.turns_used for r in results) / total if total > 0 else 0.0
        turn_efficiency = overall_success_rate / avg_turns if avg_turns > 0 else 0.0

        return MINTMetrics(
            overall_success_rate=overall_success_rate,
            total_tasks=total,
            passed_tasks=passed,
            failed_tasks=failed,
            category_success_rates=category_success_rates,
            category_counts=category_counts,
            avg_turns_to_success=avg_turns_success,
            avg_turns_to_failure=avg_turns_failure,
            turn_efficiency=turn_efficiency,
            tool_usage_rate=tool_usage_rate,
            tool_effectiveness=tool_effectiveness,
            avg_tool_uses_success=avg_tool_uses_success,
            avg_tool_uses_failure=avg_tool_uses_failure,
            feedback_usage_rate=feedback_usage_rate,
            feedback_effectiveness=feedback_effectiveness,
            avg_feedback_turns_success=avg_feedback_success,
            avg_feedback_turns_failure=avg_feedback_failure,
            multi_turn_gain=multi_turn_gain,
            turn_1_success_rate=turn_1_success,
            turn_3_success_rate=turn_3_success,
            turn_5_success_rate=turn_5_success,
            avg_latency_ms=avg_latency,
            avg_tokens_per_task=avg_tokens,
            total_tokens=total_tokens,
            total_duration_ms=total_duration,
        )

    def compare_configurations(
        self,
        baseline: MINTMetrics,
        with_tools: Optional[MINTMetrics] = None,
        with_feedback: Optional[MINTMetrics] = None,
        full: Optional[MINTMetrics] = None,
    ) -> dict[str, float]:
        """
        Compare different configuration results.

        Args:
            baseline: Results without tools or feedback
            with_tools: Results with tools only
            with_feedback: Results with feedback only
            full: Results with both tools and feedback

        Returns:
            Dictionary with comparison metrics
        """
        comparison: dict[str, float] = {
            "baseline_success_rate": baseline.overall_success_rate,
        }

        if with_tools:
            comparison["tools_success_rate"] = with_tools.overall_success_rate
            comparison["tool_improvement"] = (
                with_tools.overall_success_rate - baseline.overall_success_rate
            )

        if with_feedback:
            comparison["feedback_success_rate"] = with_feedback.overall_success_rate
            comparison["feedback_improvement"] = (
                with_feedback.overall_success_rate - baseline.overall_success_rate
            )

        if full:
            comparison["full_success_rate"] = full.overall_success_rate
            comparison["combined_improvement"] = (
                full.overall_success_rate - baseline.overall_success_rate
            )

            # Calculate synergy (combined effect vs sum of individual effects)
            if with_tools and with_feedback:
                individual_sum = (
                    comparison.get("tool_improvement", 0) +
                    comparison.get("feedback_improvement", 0)
                )
                comparison["synergy"] = (
                    comparison["combined_improvement"] - individual_sum
                )

        return comparison

    def compare_to_leaderboard(
        self,
        metrics: MINTMetrics,
        model_name: str = "elizaos",
    ) -> dict[str, dict[str, float]]:
        """
        Compare results to published leaderboard scores.

        Args:
            metrics: Calculated metrics
            model_name: Name of the model being evaluated

        Returns:
            Comparison with leaderboard models
        """
        comparison: dict[str, dict[str, float]] = {}

        # Add our results
        our_scores: dict[str, float] = {
            "overall": metrics.overall_success_rate,
        }
        for cat, rate in metrics.category_success_rates.items():
            our_scores[cat.value] = rate

        comparison[model_name] = our_scores

        # Compare with leaderboard
        for lb_model, lb_scores in LEADERBOARD_SCORES.items():
            model_comparison: dict[str, float] = {}

            # Calculate differences
            for metric_name, our_score in our_scores.items():
                lb_score = lb_scores.get(metric_name, 0.0)
                model_comparison[f"{metric_name}"] = our_score
                model_comparison[f"{metric_name}_vs_{lb_model}"] = our_score - lb_score

            comparison[f"{model_name}_vs_{lb_model}"] = model_comparison

        return comparison

    def calculate_configuration_result(
        self,
        results: list[MINTResult],
        config_name: str,
        enable_tools: bool,
        enable_feedback: bool,
    ) -> ConfigurationResult:
        """Create a ConfigurationResult from results."""
        metrics = self.calculate(results)
        return ConfigurationResult(
            config_name=config_name,
            enable_tools=enable_tools,
            enable_feedback=enable_feedback,
            metrics=metrics,
            results=results,
        )
