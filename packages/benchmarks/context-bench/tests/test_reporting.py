"""Tests for reporting module."""


from elizaos_context_bench.reporting import ContextBenchReporter
from elizaos_context_bench.types import (
    ContextBenchConfig,
    ContextBenchMetrics,
    ContextBenchResult,
    ContextBenchResults,
    ContextBenchType,
    LengthAccuracy,
    NeedlePosition,
    PositionAccuracy,
)


def create_mock_results() -> ContextBenchResults:
    """Create mock results for testing."""
    config = ContextBenchConfig(
        context_lengths=[1024, 4096],
        positions=[NeedlePosition.START, NeedlePosition.MIDDLE, NeedlePosition.END],
    )

    # Create some mock position accuracies
    position_accuracies = {
        NeedlePosition.START: PositionAccuracy(
            position=NeedlePosition.START,
            total_tasks=10,
            correct_tasks=9,
            accuracy=0.9,
            avg_semantic_similarity=0.95,
            avg_latency_ms=150.0,
        ),
        NeedlePosition.MIDDLE: PositionAccuracy(
            position=NeedlePosition.MIDDLE,
            total_tasks=10,
            correct_tasks=6,
            accuracy=0.6,
            avg_semantic_similarity=0.75,
            avg_latency_ms=180.0,
        ),
        NeedlePosition.END: PositionAccuracy(
            position=NeedlePosition.END,
            total_tasks=10,
            correct_tasks=8,
            accuracy=0.8,
            avg_semantic_similarity=0.88,
            avg_latency_ms=160.0,
        ),
    }

    length_accuracies = {
        1024: LengthAccuracy(
            context_length=1024,
            total_tasks=15,
            correct_tasks=13,
            accuracy=0.87,
            avg_semantic_similarity=0.90,
            avg_latency_ms=100.0,
        ),
        4096: LengthAccuracy(
            context_length=4096,
            total_tasks=15,
            correct_tasks=10,
            accuracy=0.67,
            avg_semantic_similarity=0.78,
            avg_latency_ms=250.0,
        ),
    }

    metrics = ContextBenchMetrics(
        total_tasks=30,
        passed_tasks=23,
        failed_tasks=7,
        overall_accuracy=0.767,
        avg_semantic_similarity=0.86,
        position_accuracies=position_accuracies,
        lost_in_middle_score=0.25,
        length_accuracies=length_accuracies,
        context_degradation_rate=0.10,
        avg_latency_ms=163.0,
        avg_tokens_per_task=2560,
        total_duration_ms=5000.0,
    )

    results = [
        ContextBenchResult(
            task_id="test_1",
            bench_type=ContextBenchType.NIAH_BASIC,
            context_length=1024,
            needle_position=NeedlePosition.START,
            actual_position_pct=5.0,
            predicted_answer="XYZ",
            expected_answer="XYZ",
            exact_match=True,
            semantic_similarity=1.0,
            retrieval_success=True,
            latency_ms=100.0,
            tokens_processed=1024,
        ),
    ]

    return ContextBenchResults(
        config=config,
        metrics=metrics,
        results=results,
        position_heatmap=[[0.9, 0.85], [0.6, 0.5], [0.8, 0.75]],
        position_heatmap_lengths=[1024, 4096],
        position_heatmap_positions=[
            NeedlePosition.START,
            NeedlePosition.MIDDLE,
            NeedlePosition.END,
        ],
        comparison_to_leaderboard={
            "gpt-4-turbo": {"overall_diff": -0.143},
            "claude-3-opus": {"overall_diff": -0.183},
        },
        summary={
            "status": "good",
            "overall_accuracy": "76.7%",
            "findings": [
                "Good overall retrieval accuracy (85-95%)",
                "Significant 'lost in middle' effect detected (25.0% drop)",
            ],
            "recommendations": [
                "Consider chunking strategies for middle content",
            ],
        },
        metadata={
            "timestamp": "2025-01-11T12:00:00",
            "seed": 42,
            "total_duration_ms": 5000.0,
        },
    )


class TestContextBenchReporter:
    """Tests for ContextBenchReporter class."""

    def test_reporter_initialization(self) -> None:
        """Test reporter initialization."""
        results = create_mock_results()
        reporter = ContextBenchReporter(results)
        assert reporter.results is not None
        assert reporter.metrics is not None

    def test_generate_ascii_heatmap(self) -> None:
        """Test ASCII heatmap generation."""
        results = create_mock_results()
        reporter = ContextBenchReporter(results)

        heatmap = reporter.generate_ascii_heatmap()

        assert "Heatmap" in heatmap
        assert len(heatmap) > 0
        # Ensure labels match the provided heatmap position labels (no enum slicing bugs)
        assert "start|" in heatmap
        assert "middle|" in heatmap
        assert "end|" in heatmap

    def test_generate_context_length_curve(self) -> None:
        """Test context length curve generation."""
        results = create_mock_results()
        reporter = ContextBenchReporter(results)

        curve = reporter.generate_context_length_curve()

        assert "Context Length" in curve
        assert len(curve) > 0

    def test_generate_markdown_report(self) -> None:
        """Test markdown report generation."""
        results = create_mock_results()
        reporter = ContextBenchReporter(results)

        report = reporter.generate_markdown_report()

        # Check for major sections
        assert "# Context Benchmark Results" in report
        assert "## Executive Summary" in report
        assert "## Overall Metrics" in report
        assert "## Position Analysis" in report
        assert "## Context Length Analysis" in report
        assert "## Leaderboard Comparison" in report

        # Check for key data
        assert "76.7%" in report or "0.767" in report
        assert "lost in middle" in report.lower()

    def test_generate_json_summary(self) -> None:
        """Test JSON summary generation."""
        results = create_mock_results()
        reporter = ContextBenchReporter(results)

        summary = reporter.generate_json_summary()

        assert "overall_accuracy" in summary
        assert "total_tasks" in summary
        assert "position_accuracies" in summary
        assert "length_accuracies" in summary
        assert "comparison_to_leaderboard" in summary

    def test_print_report_does_not_crash(self) -> None:
        """Test that print_report runs without errors."""
        results = create_mock_results()
        reporter = ContextBenchReporter(results)

        # Just ensure it doesn't crash
        reporter.print_report()
