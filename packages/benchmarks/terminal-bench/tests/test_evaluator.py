"""Tests for Terminal-Bench evaluator."""

import pytest

from elizaos_terminal_bench.evaluator import (
    TerminalBenchEvaluator,
    format_report_markdown,
)
from elizaos_terminal_bench.types import (
    CategoryMetrics,
    DifficultyMetrics,
    LeaderboardComparison,
    TaskCategory,
    TaskDifficulty,
    TerminalBenchReport,
    TerminalBenchResult,
    LEADERBOARD_SCORES,
)


class TestTerminalBenchEvaluator:
    """Test TerminalBenchEvaluator class."""

    def test_calculate_metrics_empty(self) -> None:
        """Test calculating metrics with no results."""
        evaluator = TerminalBenchEvaluator()
        metrics = evaluator.calculate_metrics([])

        assert metrics["total"] == 0
        assert metrics["accuracy"] == 0.0

    def test_calculate_metrics_all_pass(self) -> None:
        """Test calculating metrics when all tasks pass."""
        evaluator = TerminalBenchEvaluator()

        results = [
            TerminalBenchResult(
                task_id=f"task_{i}",
                success=True,
                commands_executed=5,
                total_execution_time_ms=1000.0,
                test_output="",
                tokens_used=100,
            )
            for i in range(10)
        ]

        metrics = evaluator.calculate_metrics(results)

        assert metrics["total"] == 10
        assert metrics["passed"] == 10
        assert metrics["accuracy"] == 1.0

    def test_calculate_metrics_mixed(self) -> None:
        """Test calculating metrics with mixed results."""
        evaluator = TerminalBenchEvaluator()

        results = [
            TerminalBenchResult(
                task_id=f"task_{i}",
                success=i < 6,  # 6 pass, 4 fail
                commands_executed=5,
                total_execution_time_ms=1000.0,
                test_output="",
                tokens_used=100,
            )
            for i in range(10)
        ]

        metrics = evaluator.calculate_metrics(results)

        assert metrics["total"] == 10
        assert metrics["passed"] == 6
        assert metrics["failed"] == 4
        assert metrics["accuracy"] == 0.6

    def test_calculate_category_metrics(self) -> None:
        """Test calculating metrics by category."""
        evaluator = TerminalBenchEvaluator()

        results = [
            TerminalBenchResult(
                task_id="task_1",
                success=True,
                commands_executed=5,
                total_execution_time_ms=1000.0,
                test_output="",
                category=TaskCategory.SCRIPTING,
            ),
            TerminalBenchResult(
                task_id="task_2",
                success=False,
                commands_executed=3,
                total_execution_time_ms=500.0,
                test_output="",
                category=TaskCategory.SCRIPTING,
            ),
            TerminalBenchResult(
                task_id="task_3",
                success=True,
                commands_executed=7,
                total_execution_time_ms=1500.0,
                test_output="",
                category=TaskCategory.FILE_OPERATIONS,
            ),
        ]

        by_category = evaluator.calculate_category_metrics(results)

        assert TaskCategory.SCRIPTING in by_category
        assert by_category[TaskCategory.SCRIPTING].total == 2
        assert by_category[TaskCategory.SCRIPTING].passed == 1
        assert by_category[TaskCategory.SCRIPTING].accuracy == 0.5

        assert TaskCategory.FILE_OPERATIONS in by_category
        assert by_category[TaskCategory.FILE_OPERATIONS].accuracy == 1.0

    def test_calculate_difficulty_metrics(self) -> None:
        """Test calculating metrics by difficulty."""
        evaluator = TerminalBenchEvaluator()

        results = [
            TerminalBenchResult(
                task_id="task_1",
                success=True,
                commands_executed=3,
                total_execution_time_ms=500.0,
                test_output="",
                difficulty=TaskDifficulty.EASY,
            ),
            TerminalBenchResult(
                task_id="task_2",
                success=True,
                commands_executed=5,
                total_execution_time_ms=1000.0,
                test_output="",
                difficulty=TaskDifficulty.MEDIUM,
            ),
            TerminalBenchResult(
                task_id="task_3",
                success=False,
                commands_executed=10,
                total_execution_time_ms=2000.0,
                test_output="",
                difficulty=TaskDifficulty.HARD,
            ),
        ]

        by_difficulty = evaluator.calculate_difficulty_metrics(results)

        assert TaskDifficulty.EASY in by_difficulty
        assert by_difficulty[TaskDifficulty.EASY].accuracy == 1.0

        assert TaskDifficulty.HARD in by_difficulty
        assert by_difficulty[TaskDifficulty.HARD].accuracy == 0.0

    def test_categorize_errors(self) -> None:
        """Test error categorization."""
        evaluator = TerminalBenchEvaluator()

        results = [
            TerminalBenchResult(
                task_id="task_1",
                success=False,
                commands_executed=0,
                total_execution_time_ms=0,
                test_output="",
                error_message="Timeout: task exceeded limit",
            ),
            TerminalBenchResult(
                task_id="task_2",
                success=False,
                commands_executed=5,
                total_execution_time_ms=1000.0,
                test_output="failed",
                test_exit_code=1,
            ),
            TerminalBenchResult(
                task_id="task_3",
                success=True,
                commands_executed=3,
                total_execution_time_ms=500.0,
                test_output="",
            ),
        ]

        errors = evaluator.categorize_errors(results)

        assert "Timeout" in errors
        assert "Test failed" in errors
        assert errors["Timeout"] == 1
        assert errors["Test failed"] == 1

    def test_compare_to_leaderboard_low_score(self) -> None:
        """Test leaderboard comparison with low score."""
        evaluator = TerminalBenchEvaluator()

        comparison = evaluator.compare_to_leaderboard(0.25)  # 25%

        assert comparison.our_score == 25.0
        assert comparison.rank > 5  # Should be near the bottom
        assert comparison.percentile < 50

    def test_compare_to_leaderboard_high_score(self) -> None:
        """Test leaderboard comparison with high score."""
        evaluator = TerminalBenchEvaluator()

        comparison = evaluator.compare_to_leaderboard(0.70)  # 70%

        assert comparison.our_score == 70.0
        assert comparison.rank <= 3  # Should be near the top
        assert comparison.percentile > 50

    def test_create_report(self) -> None:
        """Test creating a full report."""
        evaluator = TerminalBenchEvaluator()

        results = [
            TerminalBenchResult(
                task_id="task_1",
                success=True,
                commands_executed=5,
                total_execution_time_ms=1000.0,
                test_output="",
                tokens_used=100,
                category=TaskCategory.SCRIPTING,
                difficulty=TaskDifficulty.EASY,
            ),
        ]

        report = evaluator.create_report(
            results=results,
            evaluation_time_seconds=10.0,
            metadata={"model": "gpt-4"},
        )

        assert report.total_tasks == 1
        assert report.passed_tasks == 1
        assert report.accuracy == 1.0
        assert report.evaluation_time_seconds == 10.0
        assert report.metadata["model"] == "gpt-4"
        assert report.leaderboard_comparison is not None


class TestFormatReportMarkdown:
    """Test markdown report formatting."""

    def test_format_basic_report(self) -> None:
        """Test formatting a basic report."""
        report = TerminalBenchReport(
            total_tasks=10,
            passed_tasks=7,
            failed_tasks=3,
            accuracy=0.7,
            results=[],
            total_commands=50,
            avg_commands_per_task=5.0,
            total_tokens=1000,
            avg_tokens_per_task=100.0,
            evaluation_time_seconds=60.0,
            avg_time_per_task_seconds=6.0,
        )

        markdown = format_report_markdown(report)

        assert "# Terminal-Bench Evaluation Report" in markdown
        assert "70.0%" in markdown
        assert "7" in markdown
        assert "10" in markdown

    def test_format_report_with_leaderboard(self) -> None:
        """Test formatting report with leaderboard comparison."""
        report = TerminalBenchReport(
            total_tasks=10,
            passed_tasks=7,
            failed_tasks=3,
            accuracy=0.7,
            results=[],
            total_commands=50,
            avg_commands_per_task=5.0,
            total_tokens=1000,
            avg_tokens_per_task=100.0,
            evaluation_time_seconds=60.0,
            avg_time_per_task_seconds=6.0,
            leaderboard_comparison=LeaderboardComparison(
                our_score=70.0,
                rank=2,
                total_entries=10,
                comparison={"Agent A": 65.0},
                percentile=80.0,
            ),
        )

        markdown = format_report_markdown(report)

        assert "Leaderboard Comparison" in markdown
        assert "#2" in markdown
        assert "80.0%" in markdown

    def test_format_report_with_categories(self) -> None:
        """Test formatting report with category breakdown."""
        report = TerminalBenchReport(
            total_tasks=10,
            passed_tasks=7,
            failed_tasks=3,
            accuracy=0.7,
            results=[],
            total_commands=50,
            avg_commands_per_task=5.0,
            total_tokens=1000,
            avg_tokens_per_task=100.0,
            evaluation_time_seconds=60.0,
            avg_time_per_task_seconds=6.0,
            by_category={
                TaskCategory.SCRIPTING: CategoryMetrics(
                    total=5, passed=4, failed=1, accuracy=0.8
                ),
            },
        )

        markdown = format_report_markdown(report)

        assert "Results by Category" in markdown
        assert "scripting" in markdown

    def test_format_report_with_errors(self) -> None:
        """Test formatting report with error analysis."""
        report = TerminalBenchReport(
            total_tasks=10,
            passed_tasks=7,
            failed_tasks=3,
            accuracy=0.7,
            results=[],
            total_commands=50,
            avg_commands_per_task=5.0,
            total_tokens=1000,
            avg_tokens_per_task=100.0,
            evaluation_time_seconds=60.0,
            avg_time_per_task_seconds=6.0,
            error_categories={"Timeout": 2, "Test failed": 1},
        )

        markdown = format_report_markdown(report)

        assert "Error Analysis" in markdown
        assert "Timeout" in markdown
