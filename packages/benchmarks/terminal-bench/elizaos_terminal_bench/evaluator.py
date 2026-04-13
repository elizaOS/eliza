"""
Terminal-Bench Evaluator

Evaluates task completion using test scripts and calculates metrics.
"""

import logging
from typing import Optional

from elizaos_terminal_bench.environment import TerminalEnvironment
from elizaos_terminal_bench.types import (
    CategoryMetrics,
    DifficultyMetrics,
    LeaderboardComparison,
    LEADERBOARD_SCORES,
    TaskCategory,
    TaskDifficulty,
    TerminalBenchReport,
    TerminalBenchResult,
    TerminalTask,
)

logger = logging.getLogger(__name__)


class TerminalBenchEvaluator:
    """Evaluates Terminal-Bench task completion."""

    def __init__(self, timeout_seconds: int = 60):
        """
        Initialize the evaluator.

        Args:
            timeout_seconds: Timeout for test script execution
        """
        self.timeout_seconds = timeout_seconds

    async def evaluate_task(
        self,
        task: TerminalTask,
        environment: TerminalEnvironment,
    ) -> tuple[bool, str, int]:
        """
        Evaluate if a task was completed successfully.

        Args:
            task: The task to evaluate
            environment: The terminal environment after agent execution

        Returns:
            Tuple of (success, test_output, exit_code)
        """
        if not task.test_script:
            logger.warning(f"No test script for task {task.task_id}")
            return False, "No test script provided", -1

        try:
            success, output, exit_code = await environment.run_test(task.test_script)
            return success, output, exit_code
        except Exception as e:
            logger.error(f"Error evaluating task {task.task_id}: {e}")
            return False, str(e), -1

    def calculate_metrics(
        self, results: list[TerminalBenchResult]
    ) -> dict[str, float | int]:
        """
        Calculate aggregate metrics from results.

        Args:
            results: List of task results

        Returns:
            Dictionary of metrics
        """
        if not results:
            return {
                "total": 0,
                "passed": 0,
                "failed": 0,
                "accuracy": 0.0,
                "avg_commands": 0.0,
                "avg_tokens": 0.0,
                "avg_time_ms": 0.0,
            }

        passed = sum(1 for r in results if r.success)
        total_commands = sum(r.commands_executed for r in results)
        total_tokens = sum(r.tokens_used for r in results)
        total_time = sum(r.total_execution_time_ms for r in results)

        return {
            "total": len(results),
            "passed": passed,
            "failed": len(results) - passed,
            "accuracy": passed / len(results),
            "avg_commands": total_commands / len(results),
            "avg_tokens": total_tokens / len(results),
            "avg_time_ms": total_time / len(results),
        }

    def calculate_category_metrics(
        self, results: list[TerminalBenchResult]
    ) -> dict[TaskCategory, CategoryMetrics]:
        """Calculate metrics grouped by task category."""
        metrics: dict[TaskCategory, CategoryMetrics] = {}

        # Group results by category
        by_category: dict[TaskCategory, list[TerminalBenchResult]] = {}
        for result in results:
            if result.category:
                if result.category not in by_category:
                    by_category[result.category] = []
                by_category[result.category].append(result)

        # Calculate metrics for each category
        for category, cat_results in by_category.items():
            total = len(cat_results)
            passed = sum(1 for r in cat_results if r.success)
            avg_commands = (
                sum(r.commands_executed for r in cat_results) / total if total > 0 else 0
            )
            avg_time = (
                sum(r.total_execution_time_ms for r in cat_results) / total
                if total > 0
                else 0
            )

            metrics[category] = CategoryMetrics(
                total=total,
                passed=passed,
                failed=total - passed,
                accuracy=passed / total if total > 0 else 0.0,
                avg_commands=avg_commands,
                avg_time_ms=avg_time,
            )

        return metrics

    def calculate_difficulty_metrics(
        self, results: list[TerminalBenchResult]
    ) -> dict[TaskDifficulty, DifficultyMetrics]:
        """Calculate metrics grouped by difficulty level."""
        metrics: dict[TaskDifficulty, DifficultyMetrics] = {}

        # Group results by difficulty
        by_difficulty: dict[TaskDifficulty, list[TerminalBenchResult]] = {}
        for result in results:
            if result.difficulty:
                if result.difficulty not in by_difficulty:
                    by_difficulty[result.difficulty] = []
                by_difficulty[result.difficulty].append(result)

        # Calculate metrics for each difficulty
        for difficulty, diff_results in by_difficulty.items():
            total = len(diff_results)
            passed = sum(1 for r in diff_results if r.success)
            avg_commands = (
                sum(r.commands_executed for r in diff_results) / total
                if total > 0
                else 0
            )
            avg_time = (
                sum(r.total_execution_time_ms for r in diff_results) / total
                if total > 0
                else 0
            )

            metrics[difficulty] = DifficultyMetrics(
                total=total,
                passed=passed,
                failed=total - passed,
                accuracy=passed / total if total > 0 else 0.0,
                avg_commands=avg_commands,
                avg_time_ms=avg_time,
            )

        return metrics

    def categorize_errors(
        self, results: list[TerminalBenchResult]
    ) -> dict[str, int]:
        """Categorize errors from failed results."""
        error_categories: dict[str, int] = {}

        for result in results:
            if result.success:
                continue

            if result.error_message:
                # Simplify error message
                error_type = result.error_message.split(":")[0][:50]
                error_categories[error_type] = error_categories.get(error_type, 0) + 1
            elif result.test_exit_code != 0:
                error_categories["Test failed"] = (
                    error_categories.get("Test failed", 0) + 1
                )
            else:
                error_categories["Unknown error"] = (
                    error_categories.get("Unknown error", 0) + 1
                )

        return error_categories

    def compare_to_leaderboard(
        self,
        accuracy: float,
        leaderboard: Optional[dict[str, dict[str, float]]] = None,
    ) -> LeaderboardComparison:
        """
        Compare results to the leaderboard.

        Args:
            accuracy: Our accuracy score (0-1)
            leaderboard: Optional custom leaderboard data

        Returns:
            LeaderboardComparison with ranking information
        """
        leaderboard = leaderboard or LEADERBOARD_SCORES
        our_score = accuracy * 100  # Convert to percentage

        # Get all overall scores sorted
        scores: list[tuple[str, float]] = []
        for name, data in leaderboard.items():
            overall = data.get("overall", 0)
            scores.append((name, overall))

        scores.sort(key=lambda x: -x[1])  # Descending order

        # Calculate rank
        rank = 1
        nearest_above: Optional[tuple[str, float]] = None
        nearest_below: Optional[tuple[str, float]] = None

        for i, (name, score) in enumerate(scores):
            if our_score >= score:
                rank = i + 1
                break
            nearest_above = (name, score)
            rank = i + 2

        # Find nearest below
        for name, score in reversed(scores):
            if score < our_score:
                nearest_below = (name, score)
                break

        # Calculate percentile
        total_entries = len(scores) + 1
        percentile = ((total_entries - rank) / total_entries) * 100

        # Build comparison dict
        comparison = {name: score for name, score in scores}
        comparison["ElizaOS (This Run)"] = our_score

        return LeaderboardComparison(
            our_score=our_score,
            rank=rank,
            total_entries=total_entries,
            comparison=comparison,
            percentile=percentile,
            nearest_above=nearest_above,
            nearest_below=nearest_below,
        )

    def create_report(
        self,
        results: list[TerminalBenchResult],
        evaluation_time_seconds: float,
        metadata: Optional[dict[str, str | int | float | bool]] = None,
        compare_leaderboard: bool = True,
    ) -> TerminalBenchReport:
        """
        Create a comprehensive benchmark report.

        Args:
            results: List of task results
            evaluation_time_seconds: Total evaluation time
            metadata: Optional metadata to include
            compare_leaderboard: Whether to include leaderboard comparison

        Returns:
            TerminalBenchReport with all metrics
        """
        # Calculate basic metrics
        metrics = self.calculate_metrics(results)

        # Calculate breakdown metrics
        by_category = self.calculate_category_metrics(results)
        by_difficulty = self.calculate_difficulty_metrics(results)

        # Error analysis
        error_categories = self.categorize_errors(results)

        # Leaderboard comparison
        leaderboard_comparison = None
        if compare_leaderboard and results:
            accuracy = metrics["passed"] / metrics["total"]
            leaderboard_comparison = self.compare_to_leaderboard(accuracy)

        # Calculate additional stats
        total_tokens = sum(r.tokens_used for r in results)
        total_tasks = len(results)

        return TerminalBenchReport(
            total_tasks=total_tasks,
            passed_tasks=int(metrics["passed"]),
            failed_tasks=int(metrics["failed"]),
            accuracy=float(metrics["accuracy"]),
            results=results,
            total_commands=int(metrics["avg_commands"] * total_tasks),
            avg_commands_per_task=float(metrics["avg_commands"]),
            total_tokens=total_tokens,
            avg_tokens_per_task=float(metrics["avg_tokens"]),
            evaluation_time_seconds=evaluation_time_seconds,
            avg_time_per_task_seconds=evaluation_time_seconds / total_tasks if total_tasks > 0 else 0,
            by_category=by_category,
            by_difficulty=by_difficulty,
            error_categories=error_categories,
            leaderboard_comparison=leaderboard_comparison,
            metadata=metadata or {},
        )


def format_report_markdown(report: TerminalBenchReport) -> str:
    """
    Format a benchmark report as Markdown.

    Args:
        report: The report to format

    Returns:
        Markdown string
    """
    lines = [
        "# Terminal-Bench Evaluation Report",
        "",
        "## Summary",
        "",
        "| Metric | Value |",
        "|--------|-------|",
        f"| **Total Tasks** | {report.total_tasks} |",
        f"| **Passed** | {report.passed_tasks} |",
        f"| **Failed** | {report.failed_tasks} |",
        f"| **Accuracy** | {report.accuracy:.1%} |",
        f"| **Total Commands** | {report.total_commands} |",
        f"| **Avg Commands/Task** | {report.avg_commands_per_task:.1f} |",
        f"| **Total Tokens** | {report.total_tokens:,} |",
        f"| **Avg Tokens/Task** | {report.avg_tokens_per_task:.0f} |",
        f"| **Evaluation Time** | {report.evaluation_time_seconds:.1f}s |",
        "",
    ]

    # Leaderboard comparison
    if report.leaderboard_comparison:
        lc = report.leaderboard_comparison
        lines.extend([
            "## Leaderboard Comparison",
            "",
            "| System | Score |",
            "|--------|-------|",
        ])

        # Sort by score descending
        sorted_comparison = sorted(
            lc.comparison.items(), key=lambda x: -x[1]
        )
        for name, score in sorted_comparison:
            marker = "**" if name == "ElizaOS (This Run)" else ""
            lines.append(f"| {marker}{name}{marker} | {score:.1f}% |")

        lines.extend([
            "",
            f"**Rank**: #{lc.rank} out of {lc.total_entries}",
            f"**Percentile**: {lc.percentile:.1f}%",
            "",
        ])

        if lc.nearest_above:
            lines.append(f"*Nearest above*: {lc.nearest_above[0]} ({lc.nearest_above[1]:.1f}%)")
        if lc.nearest_below:
            lines.append(f"*Nearest below*: {lc.nearest_below[0]} ({lc.nearest_below[1]:.1f}%)")
        lines.append("")

    # By category
    if report.by_category:
        lines.extend([
            "## Results by Category",
            "",
            "| Category | Total | Passed | Accuracy | Avg Commands |",
            "|----------|-------|--------|----------|--------------|",
        ])
        for category, metrics in sorted(
            report.by_category.items(), key=lambda x: -x[1].accuracy
        ):
            lines.append(
                f"| {category.value} | {metrics.total} | {metrics.passed} | "
                f"{metrics.accuracy:.1%} | {metrics.avg_commands:.1f} |"
            )
        lines.append("")

    # By difficulty
    if report.by_difficulty:
        lines.extend([
            "## Results by Difficulty",
            "",
            "| Difficulty | Total | Passed | Accuracy | Avg Commands |",
            "|------------|-------|--------|----------|--------------|",
        ])
        difficulty_order = [TaskDifficulty.EASY, TaskDifficulty.MEDIUM, TaskDifficulty.HARD]
        for difficulty in difficulty_order:
            if difficulty in report.by_difficulty:
                metrics = report.by_difficulty[difficulty]
                lines.append(
                    f"| {difficulty.value} | {metrics.total} | {metrics.passed} | "
                    f"{metrics.accuracy:.1%} | {metrics.avg_commands:.1f} |"
                )
        lines.append("")

    # Error analysis
    if report.error_categories:
        lines.extend([
            "## Error Analysis",
            "",
            "| Error Type | Count |",
            "|------------|-------|",
        ])
        for error_type, count in sorted(
            report.error_categories.items(), key=lambda x: -x[1]
        ):
            lines.append(f"| {error_type} | {count} |")
        lines.append("")

    # Individual results
    lines.extend([
        "## Task Results",
        "",
        "| Task ID | Status | Commands | Time (ms) | Tokens |",
        "|---------|--------|----------|-----------|--------|",
    ])
    for result in report.results:
        status = "✅" if result.success else "❌"
        lines.append(
            f"| {result.task_id} | {status} | {result.commands_executed} | "
            f"{result.total_execution_time_ms:.0f} | {result.tokens_used} |"
        )
    lines.append("")

    # Metadata
    if report.metadata:
        lines.extend([
            "## Configuration",
            "",
        ])
        for key, value in report.metadata.items():
            lines.append(f"- **{key}**: {value}")
        lines.append("")

    lines.extend([
        "---",
        "*Generated by ElizaOS Terminal-Bench*",
    ])

    return "\n".join(lines)
