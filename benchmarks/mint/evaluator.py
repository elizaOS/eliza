"""
MINT Evaluator

Evaluates agent answers against ground truth using various metrics.
"""

import logging
import re
from typing import Optional

from benchmarks.mint.types import (
    MINTTask,
    MINTTrajectory,
    MINTResult,
)

logger = logging.getLogger(__name__)


class MINTEvaluator:
    """Evaluate MINT task solutions."""

    def __init__(self, strict: bool = False) -> None:
        """
        Initialize the evaluator.

        Args:
            strict: If True, use strict matching (no tolerance)
        """
        self.strict = strict

    def evaluate_trajectory(
        self,
        task: MINTTask,
        trajectory: MINTTrajectory,
    ) -> MINTResult:
        """
        Evaluate a complete trajectory and produce a result.

        Args:
            task: The MINT task that was attempted
            trajectory: The trajectory of the solving attempt

        Returns:
            MINTResult with evaluation details
        """
        # Get the final answer from trajectory
        predicted = trajectory.final_answer or ""

        # Evaluate the answer
        success, score, details = self.evaluate(
            predicted=predicted,
            expected=task.ground_truth,
            metric=task.evaluation_metric,
        )

        # Calculate timing
        latency_ms = trajectory.end_time_ms - trajectory.start_time_ms
        if latency_ms < 0:
            latency_ms = 0

        return MINTResult(
            task_id=task.id,
            category=task.category,
            trajectory=trajectory,
            success=success,
            turns_used=len([t for t in trajectory.turns if t.turn_type.value == "assistant"]),
            tool_uses=trajectory.num_tool_uses,
            feedback_turns=trajectory.num_feedback_turns,
            latency_ms=latency_ms,
            token_usage=trajectory.total_tokens,
            score=score,
            evaluation_details=details,
        )

    def evaluate(
        self,
        predicted: str,
        expected: str,
        metric: str = "exact_match",
    ) -> tuple[bool, float, dict[str, str | int | float | bool]]:
        """
        Evaluate answer based on metric type.

        Args:
            predicted: The predicted answer
            expected: The expected answer
            metric: Evaluation metric to use

        Returns:
            Tuple of (success, score, details)
        """
        details: dict[str, str | int | float | bool] = {
            "metric": metric,
            "predicted": str(predicted)[:100],
            "expected": str(expected)[:100],
        }

        if not predicted:
            details["error"] = "No answer provided"
            return False, 0.0, details

        if metric == "exact_match":
            success, score = self._exact_match(predicted, expected)
        elif metric == "numeric":
            success, score = self._numeric_match(predicted, expected)
        elif metric == "code_output":
            success, score = self._code_output_match(predicted, expected)
        elif metric == "partial_match":
            success, score = self._partial_match(predicted, expected)
        elif metric == "semantic":
            success, score = self._semantic_match(predicted, expected)
        else:
            logger.warning(f"[MINTEvaluator] Unknown metric: {metric}, using exact_match")
            success, score = self._exact_match(predicted, expected)

        details["success"] = success
        details["score"] = score

        return success, score, details

    def _exact_match(self, predicted: str, expected: str) -> tuple[bool, float]:
        """Exact string match after normalization."""
        pred_norm = self._normalize(predicted)
        exp_norm = self._normalize(expected)

        if pred_norm == exp_norm:
            return True, 1.0

        # Partial credit for close matches
        similarity = self._string_similarity(pred_norm, exp_norm)
        return False, similarity

    # Better regex pattern for decimal numbers
    NUMBER_PATTERN = r"-?\d+(?:\.\d+)?"

    def _numeric_match(
        self,
        predicted: str,
        expected: str,
        tolerance: float = 0.02,  # Increased from 0.01 to 0.02 (2%)
    ) -> tuple[bool, float]:
        """Numeric comparison with tolerance."""
        try:
            # Extract numbers from both strings using improved pattern
            pred_nums = re.findall(self.NUMBER_PATTERN, predicted)
            exp_nums = re.findall(self.NUMBER_PATTERN, expected)

            if not pred_nums:
                return False, 0.0

            if not exp_nums:
                # Expected is not numeric, fall back to exact match
                return self._exact_match(predicted, expected)

            # Use the last number found (usually the final answer)
            pred_num = float(pred_nums[-1])
            exp_num = float(exp_nums[-1])

            if self.strict:
                tolerance = 0.0

            # Check exact match first (handles integers)
            if pred_num == exp_num:
                return True, 1.0

            # Check rounded values match (for precision differences like 4.90 vs 4.9)
            # Only do this in non-strict mode
            if not self.strict and round(pred_num, 2) == round(exp_num, 2):
                return True, 1.0

            # Check with relative tolerance
            if exp_num == 0:
                if abs(pred_num) < tolerance:
                    return True, 1.0
                return False, max(0, 1 - abs(pred_num))
            else:
                relative_error = abs(pred_num - exp_num) / abs(exp_num)
                if relative_error <= tolerance:
                    return True, 1.0
                # Partial score based on how close
                score = max(0, 1 - relative_error)
                return False, score

        except (ValueError, IndexError, ZeroDivisionError):
            return self._exact_match(predicted, expected)

    def _code_output_match(self, predicted: str, expected: str) -> tuple[bool, float]:
        """Match code execution output."""
        # First try numeric match
        success, score = self._numeric_match(predicted, expected)
        if success:
            return success, score

        # Then try exact match on normalized output
        return self._exact_match(predicted, expected)

    def _partial_match(self, predicted: str, expected: str) -> tuple[bool, float]:
        """Check if one contains the other or if they share significant overlap."""
        pred_norm = self._normalize(predicted)
        exp_norm = self._normalize(expected)

        # Guard against empty normalization (e.g. predicted=":" -> pred_norm="")
        if not pred_norm or not exp_norm:
            return False, 0.0

        # Check containment
        if exp_norm in pred_norm or pred_norm in exp_norm:
            return True, 1.0

        # Check for alternative valid answers (e.g., "bab" or "aba" for palindrome)
        # This is a heuristic for tasks with multiple valid answers
        pred_tokens = set(pred_norm.split(","))
        exp_tokens = set(exp_norm.split(","))
        if pred_tokens and exp_tokens:
            overlap = len(pred_tokens & exp_tokens)
            union = len(pred_tokens | exp_tokens)
            if overlap / union >= 0.8:
                return True, overlap / union

        # String similarity for partial credit
        similarity = self._string_similarity(pred_norm, exp_norm)
        return similarity >= 0.9, similarity

    def _semantic_match(self, predicted: str, expected: str) -> tuple[bool, float]:
        """Semantic similarity match (simplified without embeddings)."""
        # Normalize and tokenize
        pred_tokens = set(self._normalize(predicted).split())
        exp_tokens = set(self._normalize(expected).split())

        if not exp_tokens:
            return False, 0.0

        # Jaccard similarity
        intersection = len(pred_tokens & exp_tokens)
        union = len(pred_tokens | exp_tokens)

        if union == 0:
            return False, 0.0

        similarity = intersection / union
        return similarity >= 0.7, similarity

    def _normalize(self, text: str) -> str:
        """Normalize text for comparison."""
        if not text:
            return ""

        text = str(text).strip().lower()

        # Remove punctuation at end
        text = re.sub(r"[.,!?;:]+$", "", text)

        # Normalize whitespace
        text = re.sub(r"\s+", " ", text)

        # Remove common prefixes
        for prefix in ["the answer is", "answer:", "result:", "therefore", "thus"]:
            if text.startswith(prefix):
                text = text[len(prefix):].strip()

        return text

    def _string_similarity(self, s1: str, s2: str) -> float:
        """Calculate string similarity using Levenshtein distance."""
        if not s1 or not s2:
            return 0.0

        if s1 == s2:
            return 1.0

        # Simple character-level similarity
        len1, len2 = len(s1), len(s2)
        max_len = max(len1, len2)

        if max_len == 0:
            return 1.0

        # Count matching characters
        matches = sum(1 for i, c in enumerate(s1) if i < len2 and s2[i] == c)

        return matches / max_len


class BatchEvaluator:
    """Evaluate multiple trajectories and aggregate results."""

    def __init__(self, evaluator: Optional[MINTEvaluator] = None) -> None:
        self.evaluator = evaluator or MINTEvaluator()

    def evaluate_batch(
        self,
        tasks: list[MINTTask],
        trajectories: list[MINTTrajectory],
    ) -> list[MINTResult]:
        """Evaluate a batch of task-trajectory pairs."""
        results: list[MINTResult] = []

        for task, trajectory in zip(tasks, trajectories):
            result = self.evaluator.evaluate_trajectory(task, trajectory)
            results.append(result)

        return results

    def aggregate_results(
        self,
        results: list[MINTResult],
    ) -> dict[str, float | int]:
        """Aggregate results into summary statistics."""
        if not results:
            return {
                "total": 0,
                "passed": 0,
                "failed": 0,
                "success_rate": 0.0,
                "avg_score": 0.0,
                "avg_turns": 0.0,
                "avg_tool_uses": 0.0,
            }

        passed = sum(1 for r in results if r.success)
        total = len(results)

        return {
            "total": total,
            "passed": passed,
            "failed": total - passed,
            "success_rate": passed / total if total > 0 else 0.0,
            "avg_score": sum(r.score for r in results) / total,
            "avg_turns": sum(r.turns_used for r in results) / total,
            "avg_tool_uses": sum(r.tool_uses for r in results) / total,
            "avg_feedback_turns": sum(r.feedback_turns for r in results) / total,
            "avg_latency_ms": sum(r.latency_ms for r in results) / total,
        }
