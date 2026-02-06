"""
Evaluator for RLM benchmark results.

Computes accuracy, strategy metrics, and cost analysis following the paper's
evaluation methodology.
"""

from __future__ import annotations

import re
from typing import Callable, Optional

from .types import (
    RLMBenchMetrics,
    RLMBenchResult,
    RLMBenchTask,
    RLMBenchType,
    RLMStrategy,
    RLMStrategyMetrics,
)


def normalize_answer(answer: str) -> str:
    """Normalize answer for comparison."""
    # Remove punctuation, lowercase, strip whitespace
    normalized = re.sub(r"[^\w\s]", "", answer.lower()).strip()
    # Collapse whitespace
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized


def compute_exact_match(predicted: str, expected: str) -> bool:
    """Check if answers match exactly (after normalization)."""
    return normalize_answer(predicted) == normalize_answer(expected)


def compute_partial_match(predicted: str, expected: str) -> float:
    """Compute partial match score (for multi-value answers)."""
    pred_tokens = set(normalize_answer(predicted).split())
    exp_tokens = set(normalize_answer(expected).split())

    if not exp_tokens:
        return 1.0 if not pred_tokens else 0.0

    intersection = pred_tokens & exp_tokens
    return len(intersection) / len(exp_tokens)


def compute_semantic_similarity(
    predicted: str,
    expected: str,
    embedding_fn: Optional[Callable[[str], list[float]]] = None,
) -> float:
    """
    Compute semantic similarity between predicted and expected answers.

    Args:
        predicted: The predicted answer
        expected: The expected answer
        embedding_fn: Optional function to compute embeddings

    Returns:
        Similarity score between 0 and 1
    """
    # If embedding function provided, use it
    if embedding_fn:
        pred_emb = embedding_fn(predicted)
        exp_emb = embedding_fn(expected)
        # Cosine similarity
        dot = sum(a * b for a, b in zip(pred_emb, exp_emb))
        norm_pred = sum(a * a for a in pred_emb) ** 0.5
        norm_exp = sum(b * b for b in exp_emb) ** 0.5
        if norm_pred * norm_exp > 0:
            return dot / (norm_pred * norm_exp)
        return 0.0

    # Fallback to token overlap
    return compute_partial_match(predicted, expected)


class RLMBenchEvaluator:
    """Evaluator for RLM benchmark results."""

    def __init__(
        self,
        semantic_threshold: float = 0.8,
        embedding_fn: Optional[Callable[[str], list[float]]] = None,
    ) -> None:
        """
        Initialize the evaluator.

        Args:
            semantic_threshold: Threshold for semantic similarity to count as correct
            embedding_fn: Optional embedding function for semantic similarity
        """
        self.semantic_threshold = semantic_threshold
        self.embedding_fn = embedding_fn

    def evaluate_result(
        self,
        task: RLMBenchTask,
        predicted_answer: str,
        iterations: int = 0,
        max_depth: int = 0,
        subcall_count: int = 0,
        strategies_used: Optional[list[str]] = None,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cost_usd: float = 0.0,
        latency_ms: float = 0.0,
        trajectory_id: Optional[str] = None,
        error: Optional[str] = None,
    ) -> RLMBenchResult:
        """
        Evaluate a single benchmark result.

        Args:
            task: The benchmark task
            predicted_answer: The model's predicted answer
            iterations: Number of RLM iterations
            max_depth: Maximum recursion depth reached
            subcall_count: Number of recursive subcalls
            strategies_used: List of strategies detected
            input_tokens: Total input tokens
            output_tokens: Total output tokens
            cost_usd: Estimated cost in USD
            latency_ms: Total latency in milliseconds
            trajectory_id: Optional trajectory ID for reference
            error: Optional error message

        Returns:
            RLMBenchResult with evaluation metrics
        """
        # Compute matches
        exact_match = compute_exact_match(predicted_answer, task.expected_answer)
        semantic_similarity = compute_semantic_similarity(
            predicted_answer,
            task.expected_answer,
            self.embedding_fn,
        )

        # Determine if correct
        is_correct = exact_match or semantic_similarity >= self.semantic_threshold

        # Compute tokens per second
        total_tokens = input_tokens + output_tokens
        tokens_per_second = (
            total_tokens / (latency_ms / 1000) if latency_ms > 0 else 0.0
        )

        return RLMBenchResult(
            task_id=task.id,
            bench_type=task.bench_type,
            context_length_tokens=task.context_length_tokens,
            predicted_answer=predicted_answer,
            expected_answer=task.expected_answer,
            exact_match=exact_match,
            semantic_similarity=semantic_similarity,
            is_correct=is_correct,
            iterations=iterations,
            max_depth=max_depth,
            subcall_count=subcall_count,
            strategies_used=strategies_used or [],
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            cost_usd=cost_usd,
            latency_ms=latency_ms,
            tokens_per_second=tokens_per_second,
            trajectory_id=trajectory_id,
            error=error,
        )

    def compute_metrics(self, results: list[RLMBenchResult]) -> RLMBenchMetrics:
        """
        Compute comprehensive metrics from all results.

        Args:
            results: List of benchmark results

        Returns:
            RLMBenchMetrics with aggregated statistics
        """
        if not results:
            return RLMBenchMetrics(
                total_tasks=0,
                passed_tasks=0,
                failed_tasks=0,
                overall_accuracy=0.0,
                avg_semantic_similarity=0.0,
            )

        # Basic counts
        total_tasks = len(results)
        passed_tasks = sum(1 for r in results if r.is_correct)
        failed_tasks = total_tasks - passed_tasks

        # Overall metrics
        overall_accuracy = passed_tasks / total_tasks
        avg_semantic_similarity = sum(r.semantic_similarity for r in results) / total_tasks

        # By benchmark type
        type_results: dict[RLMBenchType, list[RLMBenchResult]] = {}
        for r in results:
            if r.bench_type not in type_results:
                type_results[r.bench_type] = []
            type_results[r.bench_type].append(r)

        type_accuracies = {
            bench_type: sum(1 for r in rs if r.is_correct) / len(rs)
            for bench_type, rs in type_results.items()
        }

        # By context length
        length_results: dict[int, list[RLMBenchResult]] = {}
        for r in results:
            # Bucket by powers of 10
            bucket = 10 ** (len(str(r.context_length_tokens)) - 1)
            if bucket not in length_results:
                length_results[bucket] = []
            length_results[bucket].append(r)

        length_accuracies = {
            length: sum(1 for r in rs if r.is_correct) / len(rs)
            for length, rs in length_results.items()
        }

        # Strategy metrics
        strategy_counts: dict[str, int] = {}
        strategy_successes: dict[str, int] = {}
        strategy_latencies: dict[str, list[float]] = {}

        for r in results:
            for strategy in r.strategies_used:
                strategy_counts[strategy] = strategy_counts.get(strategy, 0) + 1
                if strategy not in strategy_latencies:
                    strategy_latencies[strategy] = []
                strategy_latencies[strategy].append(r.latency_ms)
                if r.is_correct:
                    strategy_successes[strategy] = strategy_successes.get(strategy, 0) + 1

        strategy_metrics: dict[RLMStrategy, RLMStrategyMetrics] = {}
        for strategy_name, count in strategy_counts.items():
            try:
                strategy = RLMStrategy(strategy_name)
            except ValueError:
                strategy = RLMStrategy.OTHER

            success_rate = strategy_successes.get(strategy_name, 0) / count
            avg_latency = (
                sum(strategy_latencies[strategy_name]) / len(strategy_latencies[strategy_name])
                if strategy_latencies.get(strategy_name)
                else 0.0
            )

            strategy_metrics[strategy] = RLMStrategyMetrics(
                strategy=strategy,
                usage_count=count,
                success_rate=success_rate,
                avg_tokens_saved=0,  # Would need baseline comparison
                avg_latency_ms=avg_latency,
            )

        # Most common strategies
        most_common = sorted(strategy_counts.keys(), key=lambda s: strategy_counts[s], reverse=True)
        most_common_strategies = []
        for s in most_common[:5]:
            try:
                most_common_strategies.append(RLMStrategy(s))
            except ValueError:
                most_common_strategies.append(RLMStrategy.OTHER)

        # Cost metrics
        total_cost = sum(r.cost_usd for r in results)
        avg_cost = total_cost / total_tasks

        # Performance metrics
        total_latency = sum(r.latency_ms for r in results)
        avg_latency = total_latency / total_tasks
        avg_iterations = sum(r.iterations for r in results) / total_tasks
        avg_depth = sum(r.max_depth for r in results) / total_tasks
        total_tokens = sum(r.total_tokens for r in results)

        # S-NIAH by length (Paper Table 1 format)
        s_niah_results = [r for r in results if r.bench_type == RLMBenchType.S_NIAH]
        s_niah_by_length: dict[str, float] = {}
        for length_label, min_tokens, max_tokens in [
            ("1K", 0, 2000),
            ("10K", 2000, 20000),
            ("100K", 20000, 200000),
            ("1M", 200000, 2000000),
            ("10M", 2000000, 20000000),
            ("100M", 20000000, 200000000),
        ]:
            matching = [
                r for r in s_niah_results
                if min_tokens <= r.context_length_tokens < max_tokens
            ]
            if matching:
                s_niah_by_length[length_label] = sum(1 for r in matching if r.is_correct) / len(matching)

        # OOLONG metrics
        oolong_results = [r for r in results if r.bench_type == RLMBenchType.OOLONG]
        oolong_accuracy = (
            sum(1 for r in oolong_results if r.is_correct) / len(oolong_results)
            if oolong_results
            else 0.0
        )

        oolong_pairs_results = [r for r in results if r.bench_type == RLMBenchType.OOLONG_PAIRS]
        oolong_pairs_accuracy = (
            sum(1 for r in oolong_pairs_results if r.is_correct) / len(oolong_pairs_results)
            if oolong_pairs_results
            else 0.0
        )

        # Cost vs accuracy analysis
        cost_accuracy_pairs: list[tuple[float, float]] = []
        for r in results:
            cost_accuracy_pairs.append((r.cost_usd, 1.0 if r.is_correct else 0.0))

        return RLMBenchMetrics(
            total_tasks=total_tasks,
            passed_tasks=passed_tasks,
            failed_tasks=failed_tasks,
            overall_accuracy=overall_accuracy,
            avg_semantic_similarity=avg_semantic_similarity,
            type_accuracies=type_accuracies,
            length_accuracies=length_accuracies,
            strategy_metrics=strategy_metrics,
            most_common_strategies=most_common_strategies,
            total_cost_usd=total_cost,
            avg_cost_per_task_usd=avg_cost,
            cost_vs_accuracy=cost_accuracy_pairs,
            avg_latency_ms=avg_latency,
            avg_iterations=avg_iterations,
            avg_depth=avg_depth,
            total_tokens_processed=total_tokens,
            total_duration_ms=total_latency,
            s_niah_by_length=s_niah_by_length,
            oolong_accuracy=oolong_accuracy,
            oolong_pairs_accuracy=oolong_pairs_accuracy,
        )
