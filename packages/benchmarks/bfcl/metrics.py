"""
BFCL Metrics Calculator

Calculates comprehensive metrics from BFCL benchmark results.
"""

from __future__ import annotations

import logging
import statistics
from typing import Optional

from benchmarks.bfcl.types import (
    BFCLCategory,
    BFCLMetrics,
    BFCLResult,
    BaselineScore,
    CategoryMetrics,
    LEADERBOARD_SCORES,
)

logger = logging.getLogger(__name__)


class MetricsCalculator:
    """
    Calculate comprehensive metrics from BFCL results.

    Computes:
    - Overall accuracy scores
    - Per-category breakdowns
    - Latency statistics
    - Error analysis
    - Baseline comparisons
    """

    # Official BFCL weighting for overall score
    CATEGORY_WEIGHTS: dict[BFCLCategory, float] = {
        BFCLCategory.SIMPLE: 0.15,
        BFCLCategory.MULTIPLE: 0.15,
        BFCLCategory.PARALLEL: 0.15,
        BFCLCategory.PARALLEL_MULTIPLE: 0.15,
        BFCLCategory.RELEVANCE: 0.10,
        BFCLCategory.REST_API: 0.10,
        BFCLCategory.SQL: 0.08,
        BFCLCategory.JAVA: 0.06,
        BFCLCategory.JAVASCRIPT: 0.06,
    }

    def calculate(self, results: list[BFCLResult]) -> BFCLMetrics:
        """
        Calculate comprehensive metrics from results.

        Args:
            results: List of test results

        Returns:
            Calculated metrics
        """
        if not results:
            return self._empty_metrics()

        # Filter out results without ground truth for accuracy calculations
        # These are tests we cannot evaluate (e.g., REST API without expected calls)
        valid_results = [
            r for r in results
            if not r.details.get("no_ground_truth", False)
        ]
        
        if not valid_results:
            logger.warning("No valid results with ground truth available for metrics")
            return self._empty_metrics()

        # Calculate per-category metrics (using valid results only)
        category_metrics = self._calculate_category_metrics(valid_results)

        # Calculate overall scores (using valid results only)
        ast_accuracy = self._calculate_accuracy(valid_results, "ast_match")
        exec_accuracy = self._calculate_accuracy(valid_results, "exec_success")
        relevance_accuracy = self._calculate_accuracy(valid_results, "relevance_correct")

        # Calculate weighted overall score
        overall_score = self._calculate_weighted_score(category_metrics)

        # Calculate latency statistics (use all results - we ran them all)
        latencies = [r.latency_ms for r in results if r.latency_ms > 0]
        latency_stats = self._calculate_latency_stats(latencies)

        # Analyze errors (valid results only)
        error_counts = self._analyze_errors(valid_results)
        
        # Track tests without ground truth
        no_gt_count = len(results) - len(valid_results)
        if no_gt_count > 0:
            error_counts["no_ground_truth"] = no_gt_count
            logger.info(f"Excluded {no_gt_count} tests without ground truth from accuracy calculations")

        return BFCLMetrics(
            overall_score=overall_score,
            ast_accuracy=ast_accuracy,
            exec_accuracy=exec_accuracy,
            relevance_accuracy=relevance_accuracy,
            category_metrics=category_metrics,
            total_tests=len(valid_results),  # Count only valid tests
            passed_tests=sum(1 for r in valid_results if r.ast_match),
            failed_tests=sum(1 for r in valid_results if not r.ast_match),
            latency_p50=latency_stats.get("p50", 0.0),
            latency_p95=latency_stats.get("p95", 0.0),
            latency_p99=latency_stats.get("p99", 0.0),
            avg_latency_ms=latency_stats.get("avg", 0.0),
            error_counts=error_counts,
        )

    def _empty_metrics(self) -> BFCLMetrics:
        """Return empty metrics for no results."""
        return BFCLMetrics(
            overall_score=0.0,
            ast_accuracy=0.0,
            exec_accuracy=0.0,
            relevance_accuracy=0.0,
        )

    def _calculate_category_metrics(
        self,
        results: list[BFCLResult],
    ) -> dict[BFCLCategory, CategoryMetrics]:
        """Calculate metrics per category."""
        category_results: dict[BFCLCategory, list[BFCLResult]] = {}

        for result in results:
            if result.category not in category_results:
                category_results[result.category] = []
            category_results[result.category].append(result)

        category_metrics: dict[BFCLCategory, CategoryMetrics] = {}

        for category, cat_results in category_results.items():
            if not cat_results:
                continue

            ast_acc = self._calculate_accuracy(cat_results, "ast_match")
            exec_acc = self._calculate_accuracy(cat_results, "exec_success")
            rel_acc = self._calculate_accuracy(cat_results, "relevance_correct")
            avg_latency = statistics.mean(
                r.latency_ms for r in cat_results if r.latency_ms > 0
            ) if any(r.latency_ms > 0 for r in cat_results) else 0.0

            category_metrics[category] = CategoryMetrics(
                category=category,
                total_tests=len(cat_results),
                ast_accuracy=ast_acc,
                exec_accuracy=exec_acc,
                relevance_accuracy=rel_acc,
                avg_latency_ms=avg_latency,
            )

        return category_metrics

    def _calculate_accuracy(
        self,
        results: list[BFCLResult],
        field: str,
    ) -> float:
        """Calculate accuracy for a specific field."""
        if not results:
            return 0.0

        correct = sum(1 for r in results if getattr(r, field, False))
        return correct / len(results)

    def _calculate_weighted_score(
        self,
        category_metrics: dict[BFCLCategory, CategoryMetrics],
    ) -> float:
        """Calculate weighted overall score based on BFCL specification."""
        if not category_metrics:
            return 0.0

        total_weight = 0.0
        weighted_sum = 0.0

        for category, metrics in category_metrics.items():
            weight = self.CATEGORY_WEIGHTS.get(category, 0.1)
            weighted_sum += metrics.ast_accuracy * weight
            total_weight += weight

        if total_weight == 0:
            return 0.0

        return weighted_sum / total_weight

    def _calculate_latency_stats(
        self,
        latencies: list[float],
    ) -> dict[str, float]:
        """Calculate latency statistics."""
        if not latencies:
            return {"avg": 0.0, "p50": 0.0, "p95": 0.0, "p99": 0.0}

        sorted_latencies = sorted(latencies)
        n = len(sorted_latencies)

        return {
            "avg": statistics.mean(latencies),
            "p50": sorted_latencies[int(n * 0.5)],
            "p95": sorted_latencies[min(int(n * 0.95), n - 1)],
            "p99": sorted_latencies[min(int(n * 0.99), n - 1)],
        }

    def _analyze_errors(
        self,
        results: list[BFCLResult],
    ) -> dict[str, int]:
        """Analyze and categorize errors."""
        error_counts: dict[str, int] = {
            "name_mismatch": 0,
            "argument_mismatch": 0,
            "missing_call": 0,
            "extra_call": 0,
            "type_error": 0,
            "relevance_error": 0,
            "execution_error": 0,
            "timeout": 0,
            "other": 0,
        }

        for result in results:
            if result.ast_match:
                continue

            # Categorize the error
            if result.error:
                if "timeout" in result.error.lower():
                    error_counts["timeout"] += 1
                elif "type" in result.error.lower():
                    error_counts["type_error"] += 1
                else:
                    error_counts["other"] += 1
                continue

            details = result.details
            if not details:
                error_counts["other"] += 1
                continue

            mismatch_reason = details.get("mismatch_reason", "")
            if mismatch_reason == "count_mismatch":
                pred_count = int(details.get("predicted_count", 0) or 0)
                exp_count = int(details.get("expected_count", 0) or 0)
                if pred_count < exp_count:
                    error_counts["missing_call"] += 1
                else:
                    error_counts["extra_call"] += 1
            else:
                mismatches = details.get("mismatches", [])
                if isinstance(mismatches, list) and mismatches:
                    for mismatch in mismatches:
                        if "name" in str(mismatch).lower():
                            error_counts["name_mismatch"] += 1
                            break
                        elif "arg" in str(mismatch).lower():
                            error_counts["argument_mismatch"] += 1
                            break
                else:
                    error_counts["other"] += 1

            if not result.relevance_correct:
                error_counts["relevance_error"] += 1

            if not result.exec_success and result.ast_match:
                error_counts["execution_error"] += 1

        return error_counts

    def compare_to_baselines(
        self,
        metrics: BFCLMetrics,
        baselines: Optional[dict[str, BaselineScore]] = None,
    ) -> dict[str, float]:
        """
        Compare metrics to baseline scores.

        Args:
            metrics: Calculated metrics
            baselines: Optional custom baselines (uses leaderboard if not provided)

        Returns:
            Dict mapping model name to score difference (positive = better than baseline)
        """
        if baselines is None:
            baselines = LEADERBOARD_SCORES

        comparison: dict[str, float] = {}

        for model_name, baseline in baselines.items():
            diff = metrics.overall_score - baseline.overall
            comparison[model_name] = diff

        return comparison

    def calculate_leaderboard_position(
        self,
        metrics: BFCLMetrics,
        baselines: Optional[dict[str, BaselineScore]] = None,
    ) -> tuple[int, str]:
        """
        Determine position on the leaderboard.

        Args:
            metrics: Calculated metrics
            baselines: Optional custom baselines

        Returns:
            Tuple of (position, closest_model)
        """
        if baselines is None:
            baselines = LEADERBOARD_SCORES

        # Sort baselines by overall score
        sorted_baselines = sorted(
            baselines.items(),
            key=lambda x: x[1].overall,
            reverse=True,
        )

        position = 1
        closest_model = ""
        min_diff = float("inf")

        for i, (model_name, baseline) in enumerate(sorted_baselines):
            if metrics.overall_score > baseline.overall:
                position = i + 1
                break
            position = i + 2

            diff = abs(metrics.overall_score - baseline.overall)
            if diff < min_diff:
                min_diff = diff
                closest_model = model_name

        return position, closest_model

    def format_metrics_table(
        self,
        metrics: BFCLMetrics,
    ) -> str:
        """Format metrics as a readable table."""
        lines = [
            "=" * 60,
            "BFCL BENCHMARK RESULTS",
            "=" * 60,
            "",
            f"Overall Score: {metrics.overall_score:.2%}",
            f"AST Accuracy:  {metrics.ast_accuracy:.2%}",
            f"Exec Accuracy: {metrics.exec_accuracy:.2%}",
            f"Relevance:     {metrics.relevance_accuracy:.2%}",
            "",
            f"Total Tests:   {metrics.total_tests}",
            f"Passed:        {metrics.passed_tests}",
            f"Failed:        {metrics.failed_tests}",
            "",
            "-" * 60,
            "Per-Category Results:",
            "-" * 60,
        ]

        for category in BFCLCategory:
            cat_metrics = metrics.category_metrics.get(category)
            if cat_metrics:
                lines.append(
                    f"  {category.value:20} "
                    f"AST: {cat_metrics.ast_accuracy:.2%}  "
                    f"Tests: {cat_metrics.total_tests}"
                )

        lines.extend([
            "",
            "-" * 60,
            "Latency Statistics:",
            "-" * 60,
            f"  Average: {metrics.avg_latency_ms:.1f}ms",
            f"  P50:     {metrics.latency_p50:.1f}ms",
            f"  P95:     {metrics.latency_p95:.1f}ms",
            f"  P99:     {metrics.latency_p99:.1f}ms",
            "",
            "=" * 60,
        ])

        return "\n".join(lines)
