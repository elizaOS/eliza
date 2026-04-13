"""
Mind2Web evaluator.

Evaluates agent predictions against ground truth actions.
"""

from __future__ import annotations

import logging

from benchmarks.mind2web.types import (
    Mind2WebAction,
    Mind2WebActionStep,
    Mind2WebOperation,
    Mind2WebResult,
    Mind2WebStepResult,
    Mind2WebTask,
)

logger = logging.getLogger(__name__)


class Mind2WebEvaluator:
    """Evaluator for Mind2Web benchmark."""

    def __init__(self, *, strict_element_match: bool = False) -> None:
        """Initialize evaluator.

        Args:
            strict_element_match: If True, require exact backend_node_id match.
                                  If False, allow fuzzy matching on attributes.
        """
        self.strict_element_match = strict_element_match

    def evaluate_task(
        self,
        task: Mind2WebTask,
        predictions: list[Mind2WebAction],
        *,
        trial_number: int = 1,
        latency_ms: float = 0.0,
    ) -> Mind2WebResult:
        """Evaluate agent predictions for a task.

        Args:
            task: The Mind2Web task with ground truth
            predictions: Agent's predicted actions
            trial_number: Trial number for this evaluation
            latency_ms: Total latency for the task

        Returns:
            Mind2WebResult with evaluation metrics
        """
        step_results: list[Mind2WebStepResult] = []
        total_steps = len(task.actions)

        element_correct_count = 0
        operation_correct_count = 0
        step_correct_count = 0

        for i, ground_truth in enumerate(task.actions):
            predicted = predictions[i] if i < len(predictions) else None

            step_result = self._evaluate_step(i, predicted, ground_truth)
            step_results.append(step_result)

            if step_result.element_correct:
                element_correct_count += 1
            if step_result.operation_correct:
                operation_correct_count += 1
            if step_result.step_correct:
                step_correct_count += 1

        element_accuracy = element_correct_count / total_steps if total_steps > 0 else 0.0
        operation_accuracy = operation_correct_count / total_steps if total_steps > 0 else 0.0
        step_accuracy = step_correct_count / total_steps if total_steps > 0 else 0.0

        # Task is successful if all steps are correct
        success = step_correct_count == total_steps and total_steps > 0

        return Mind2WebResult(
            task_id=task.annotation_id,
            instruction=task.confirmed_task,
            website=task.website,
            domain=task.domain,
            trial_number=trial_number,
            success=success,
            element_accuracy=element_accuracy,
            operation_accuracy=operation_accuracy,
            step_accuracy=step_accuracy,
            steps_completed=len(predictions),
            total_steps=total_steps,
            step_results=step_results,
            latency_ms=latency_ms,
            agent_trajectory=list(predictions),
        )

    def _evaluate_step(
        self,
        step_index: int,
        predicted: Mind2WebAction | None,
        ground_truth: Mind2WebActionStep,
    ) -> Mind2WebStepResult:
        """Evaluate a single step prediction.

        Args:
            step_index: Index of this step
            predicted: Agent's predicted action (may be None)
            ground_truth: Ground truth action step

        Returns:
            Mind2WebStepResult with step-level metrics
        """
        if predicted is None:
            return Mind2WebStepResult(
                step_index=step_index,
                predicted_action=None,
                ground_truth=ground_truth,
                element_correct=False,
                operation_correct=False,
                value_correct=False,
                step_correct=False,
            )

        # Check operation
        operation_correct = self._check_operation(predicted.operation, ground_truth.operation)

        # Check element
        element_correct = self._check_element(predicted.element_id, ground_truth)

        # Check value (for TYPE and SELECT operations)
        value_correct = self._check_value(
            predicted.value, ground_truth.value, ground_truth.operation
        )

        # Step is correct if element and operation match (and value for TYPE/SELECT)
        if ground_truth.operation in (Mind2WebOperation.TYPE, Mind2WebOperation.SELECT):
            step_correct = element_correct and operation_correct and value_correct
        else:
            step_correct = element_correct and operation_correct

        return Mind2WebStepResult(
            step_index=step_index,
            predicted_action=predicted,
            ground_truth=ground_truth,
            element_correct=element_correct,
            operation_correct=operation_correct,
            value_correct=value_correct,
            step_correct=step_correct,
        )

    def _check_operation(
        self, predicted: Mind2WebOperation, ground_truth: Mind2WebOperation
    ) -> bool:
        """Check if predicted operation matches ground truth."""
        # Direct match
        if predicted == ground_truth:
            return True

        # HOVER and ENTER are sometimes mapped to CLICK
        if ground_truth in (Mind2WebOperation.HOVER, Mind2WebOperation.ENTER):
            return predicted == Mind2WebOperation.CLICK

        return False

    def _check_element(self, predicted_id: str, ground_truth: Mind2WebActionStep) -> bool:
        """Check if predicted element matches any positive candidate."""
        if not predicted_id:
            return False

        target = ground_truth.target_element
        if target is None:
            return False

        # Strict match: exact backend_node_id
        if self.strict_element_match:
            return predicted_id == target.backend_node_id

        # Fuzzy match: check if predicted_id matches backend_node_id or key attributes
        if predicted_id == target.backend_node_id:
            return True

        # Check against all positive candidates
        for candidate in ground_truth.pos_candidates:
            if predicted_id == candidate.backend_node_id:
                return True

            # Check if predicted_id matches any attribute value (id, name, class, etc.)
            for attr_value in candidate.attributes.values():
                if predicted_id == attr_value:
                    return True

                # Partial match for CSS selectors
                if predicted_id.startswith("#") and attr_value == predicted_id[1:]:
                    return True
                if predicted_id.startswith(".") and predicted_id[1:] in attr_value:
                    return True

        return False

    def _check_value(
        self, predicted: str, ground_truth: str, operation: Mind2WebOperation
    ) -> bool:
        """Check if predicted value matches ground truth (for TYPE/SELECT)."""
        if operation not in (Mind2WebOperation.TYPE, Mind2WebOperation.SELECT):
            return True  # Value not applicable

        if not ground_truth:
            return True  # No expected value

        # Normalize for comparison
        pred_norm = predicted.strip().lower()
        gt_norm = ground_truth.strip().lower()

        # Exact match
        if pred_norm == gt_norm:
            return True

        # Substring match (predicted contains ground truth)
        if gt_norm in pred_norm or pred_norm in gt_norm:
            return True

        return False

    def compute_aggregate_metrics(
        self, results: list[Mind2WebResult]
    ) -> dict[str, float]:
        """Compute aggregate metrics across multiple results.

        Args:
            results: List of Mind2WebResult objects

        Returns:
            Dictionary of aggregate metrics
        """
        if not results:
            return {
                "overall_element_accuracy": 0.0,
                "overall_operation_accuracy": 0.0,
                "overall_step_accuracy": 0.0,
                "overall_task_success_rate": 0.0,
                "average_latency_ms": 0.0,
            }

        total_element_acc = sum(r.element_accuracy for r in results)
        total_operation_acc = sum(r.operation_accuracy for r in results)
        total_step_acc = sum(r.step_accuracy for r in results)
        total_success = sum(1 for r in results if r.success)
        total_latency = sum(r.latency_ms for r in results)

        n = len(results)

        return {
            "overall_element_accuracy": total_element_acc / n,
            "overall_operation_accuracy": total_operation_acc / n,
            "overall_step_accuracy": total_step_acc / n,
            "overall_task_success_rate": total_success / n,
            "average_latency_ms": total_latency / n,
        }
