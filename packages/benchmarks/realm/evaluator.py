"""
REALM-Bench Evaluator

Evaluates agent trajectories against REALM benchmark criteria.
"""

import logging

from benchmarks.realm.types import (
    PlanningTrajectory,
    REALMCategory,
    REALMMetrics,
    REALMResult,
    REALMResultMetrics,
    REALMResultDetails,
    REALMTask,
    REALMTestCase,
)

logger = logging.getLogger(__name__)


class REALMEvaluator:
    """Evaluator for REALM benchmark results."""

    def evaluate_trajectory(
        self,
        task: REALMTask,
        test_case: REALMTestCase,
        trajectory: PlanningTrajectory,
    ) -> REALMResult:
        """
        Evaluate a trajectory against the expected results.

        Args:
            task: The REALM task
            test_case: The test case with expected values
            trajectory: The execution trajectory

        Returns:
            REALMResult with evaluation metrics
        """
        # Calculate metrics
        planning_time = self._estimate_planning_time(trajectory)
        execution_time = trajectory.duration_ms - planning_time
        plan_quality = trajectory.plan_quality_score
        goal_achievement = self._calculate_goal_achievement(trajectory, test_case)
        efficiency = self._calculate_efficiency(trajectory, task)

        # Determine overall success
        success = (
            trajectory.overall_success
            and goal_achievement >= 0.5
            and efficiency >= 0.3
        )

        # Get actions performed
        actions_performed = [step.action.name for step in trajectory.steps]

        # Build result
        result = REALMResult(
            task_id=task.id,
            category=task.category,
            trajectory=trajectory,
            success=success,
            steps_executed=len(trajectory.steps),
            actions_performed=actions_performed,
            plan_generated={
                "goal": task.goal,
                "steps": [{"id": str(i), "action": s.action.name} for i, s in enumerate(trajectory.steps)],
            },
            duration_ms=trajectory.duration_ms,
            token_usage=trajectory.tokens_used,
            error=trajectory.final_outcome if not success else None,
            metrics=REALMResultMetrics(
                planning_time=planning_time,
                execution_time=execution_time,
                plan_quality=plan_quality,
                goal_achievement=goal_achievement,
                efficiency=efficiency,
            ),
            details=REALMResultDetails(
                plan_adaptations=trajectory.adaptation_count,
                error_recoveries=sum(1 for s in trajectory.steps if not s.success and s.error),
                tokens=trajectory.tokens_used,
                duration=trajectory.duration_ms,
            ),
        )

        return result

    def _estimate_planning_time(self, trajectory: PlanningTrajectory) -> float:
        """Estimate planning time from trajectory."""
        # Assume planning takes about 20-30% of total time
        return trajectory.duration_ms * 0.25

    def _calculate_goal_achievement(
        self,
        trajectory: PlanningTrajectory,
        test_case: REALMTestCase,
    ) -> float:
        """Calculate how well the goal was achieved."""
        if not trajectory.steps:
            return 0.0

        # Check required actions
        expected_actions = test_case.expected.get("actions", [])
        if isinstance(expected_actions, list) and expected_actions:
            executed_actions = {s.action.name for s in trajectory.steps if s.success}
            matched = len(set(expected_actions) & executed_actions)
            return matched / len(expected_actions)

        # Fallback: based on success rate
        successful = sum(1 for s in trajectory.steps if s.success)
        return successful / len(trajectory.steps) if trajectory.steps else 0.0

    def _calculate_efficiency(
        self,
        trajectory: PlanningTrajectory,
        task: REALMTask,
    ) -> float:
        """Calculate execution efficiency."""
        if not trajectory.steps:
            return 0.0

        # Time efficiency
        time_limit = task.timeout_ms
        time_ratio = 1.0 - (trajectory.duration_ms / time_limit)
        time_efficiency = max(0.0, min(1.0, time_ratio))

        # Step efficiency
        expected_steps = len(task.available_tools)
        actual_steps = len(trajectory.steps)
        step_ratio = expected_steps / actual_steps if actual_steps > 0 else 0.0
        step_efficiency = min(1.0, step_ratio)

        # Combined efficiency
        return (time_efficiency + step_efficiency) / 2


class MetricsCalculator:
    """Calculator for aggregate benchmark metrics."""

    def calculate(self, results: list[REALMResult]) -> REALMMetrics:
        """Calculate aggregate metrics from a list of results."""
        if not results:
            return REALMMetrics(
                overall_success_rate=0.0,
                total_tasks=0,
                passed_tasks=0,
                failed_tasks=0,
            )

        total = len(results)
        passed = sum(1 for r in results if r.success)
        failed = total - passed

        # Per-category metrics
        category_success_rates: dict[REALMCategory, float] = {}
        category_counts: dict[REALMCategory, int] = {}
        
        for category in REALMCategory:
            cat_results = [r for r in results if r.category == category]
            if cat_results:
                cat_passed = sum(1 for r in cat_results if r.success)
                category_success_rates[category] = cat_passed / len(cat_results)
                category_counts[category] = len(cat_results)

        # Planning metrics
        avg_plan_quality = sum(r.metrics.plan_quality for r in results) / total
        avg_goal_achievement = sum(r.metrics.goal_achievement for r in results) / total
        avg_efficiency = sum(r.metrics.efficiency for r in results) / total

        # Execution metrics
        successful_results = [r for r in results if r.success]
        failed_results = [r for r in results if not r.success]

        avg_steps_success = (
            sum(r.steps_executed for r in successful_results) / len(successful_results)
            if successful_results else 0.0
        )
        avg_steps_failure = (
            sum(r.steps_executed for r in failed_results) / len(failed_results)
            if failed_results else 0.0
        )

        avg_planning_time = sum(r.metrics.planning_time for r in results) / total
        avg_execution_time = sum(r.metrics.execution_time for r in results) / total

        # Adaptation metrics
        adaptation_rate = sum(1 for r in results if r.details.plan_adaptations > 0) / total if total > 0 else 0.0
        
        adapted_results = [r for r in results if r.details.plan_adaptations > 0]
        adaptation_success_rate = (
            sum(1 for r in adapted_results if r.success) / len(adapted_results)
            if adapted_results else 0.0
        )

        # Performance metrics
        avg_latency = sum(r.duration_ms for r in results) / total
        avg_tokens = sum(r.token_usage for r in results) / total
        total_tokens = sum(r.token_usage for r in results)
        total_duration = sum(r.duration_ms for r in results)

        return REALMMetrics(
            overall_success_rate=passed / total,
            total_tasks=total,
            passed_tasks=passed,
            failed_tasks=failed,
            category_success_rates=category_success_rates,
            category_counts=category_counts,
            avg_plan_quality=avg_plan_quality,
            avg_goal_achievement=avg_goal_achievement,
            avg_efficiency=avg_efficiency,
            avg_steps_to_success=avg_steps_success,
            avg_steps_to_failure=avg_steps_failure,
            avg_planning_time_ms=avg_planning_time,
            avg_execution_time_ms=avg_execution_time,
            adaptation_rate=adaptation_rate,
            adaptation_success_rate=adaptation_success_rate,
            avg_latency_ms=avg_latency,
            avg_tokens_per_task=avg_tokens,
            total_tokens=total_tokens,
            total_duration_ms=total_duration,
        )

    def compare_to_leaderboard(
        self,
        metrics: REALMMetrics,
        leaderboard: dict[str, dict[str, float]],
    ) -> dict[str, dict[str, float]]:
        """Compare metrics to leaderboard scores."""
        comparison: dict[str, dict[str, float]] = {}

        our_overall = metrics.overall_success_rate * 100

        for model_name, scores in leaderboard.items():
            model_overall = scores.get("overall", 0)
            
            comparison[model_name] = {
                "their_score": model_overall,
                "our_score": our_overall,
                "difference": our_overall - model_overall,
                "better": 1.0 if our_overall > model_overall else 0.0,
            }

            # Per-category comparison
            for category in REALMCategory:
                cat_key = category.value
                if cat_key in scores and category in metrics.category_success_rates:
                    our_cat = metrics.category_success_rates[category] * 100
                    their_cat = scores[cat_key]
                    comparison[model_name][f"{cat_key}_diff"] = our_cat - their_cat

        return comparison
