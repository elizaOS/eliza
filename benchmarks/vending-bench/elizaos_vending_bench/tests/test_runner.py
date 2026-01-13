"""Tests for Vending-Bench runner."""

import json
import tempfile
from decimal import Decimal
from pathlib import Path

import pytest

from elizaos_vending_bench.runner import VendingBenchRunner
from elizaos_vending_bench.types import (
    LEADERBOARD_SCORES,
    VendingBenchConfig,
)


class TestVendingBenchRunner:
    """Test VendingBenchRunner class."""

    def test_create_runner(self) -> None:
        """Test creating a runner."""
        config = VendingBenchConfig(num_runs=1, max_days_per_run=5)
        runner = VendingBenchRunner(config)

        assert runner.config == config
        assert runner.llm_provider is None

    @pytest.mark.asyncio
    async def test_run_single_trial(self) -> None:
        """Test running a single trial."""
        config = VendingBenchConfig(
            num_runs=1,
            max_days_per_run=3,
            random_seed=42,
            generate_report=False,
        )
        runner = VendingBenchRunner(config)

        result = await runner._run_single(run_idx=0, run_id="test_001")

        assert result.run_id == "test_001"
        # May end early if bankrupt
        assert result.simulation_days <= 3
        assert result.initial_cash == Decimal("500.00")

    @pytest.mark.asyncio
    async def test_run_benchmark_multiple_runs(self) -> None:
        """Test running benchmark with multiple runs."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config = VendingBenchConfig(
                num_runs=3,
                max_days_per_run=5,
                random_seed=42,
                output_dir=tmpdir,
                generate_report=True,
                compare_leaderboard=True,
            )
            runner = VendingBenchRunner(config)

            report = await runner.run_benchmark()

            assert len(report.results) == 3
            assert report.metrics is not None
            assert report.leaderboard_comparison is not None

            # Check output files were created
            output_path = Path(tmpdir)
            json_files = list(output_path.glob("*.json"))
            md_files = list(output_path.glob("*.md"))
            assert len(json_files) >= 1
            assert len(md_files) >= 1

    @pytest.mark.asyncio
    async def test_calculate_metrics(self) -> None:
        """Test metrics calculation."""
        config = VendingBenchConfig(
            num_runs=3,
            max_days_per_run=5,
            random_seed=42,
            generate_report=False,
        )
        runner = VendingBenchRunner(config)

        report = await runner.run_benchmark()

        metrics = report.metrics
        assert metrics.avg_net_worth > 0
        assert metrics.max_net_worth >= metrics.min_net_worth
        assert 0 <= metrics.success_rate <= 1
        assert 0 <= metrics.coherence_score <= 1

    @pytest.mark.asyncio
    async def test_leaderboard_comparison(self) -> None:
        """Test leaderboard comparison."""
        config = VendingBenchConfig(
            num_runs=1,
            max_days_per_run=10,
            random_seed=42,
            generate_report=False,
            compare_leaderboard=True,
        )
        runner = VendingBenchRunner(config)

        report = await runner.run_benchmark()

        comparison = report.leaderboard_comparison
        assert comparison is not None
        assert comparison.our_rank >= 1
        assert comparison.total_entries == len(LEADERBOARD_SCORES) + 1
        assert 0 <= comparison.percentile <= 100
        assert len(comparison.comparisons) > 0

    @pytest.mark.asyncio
    async def test_summary_generation(self) -> None:
        """Test summary generation."""
        config = VendingBenchConfig(
            num_runs=2,
            max_days_per_run=5,
            random_seed=42,
            generate_report=False,
        )
        runner = VendingBenchRunner(config)

        report = await runner.run_benchmark()

        summary = report.summary
        assert "status" in summary
        assert "best_net_worth" in summary
        assert "key_findings" in summary
        assert "recommendations" in summary

    @pytest.mark.asyncio
    async def test_handles_failed_runs(self) -> None:
        """Test handling of failed simulation runs."""
        # Use very low initial cash to force bankruptcy
        config = VendingBenchConfig(
            num_runs=2,
            max_days_per_run=30,
            initial_cash=Decimal("1.00"),  # Will go bankrupt quickly
            random_seed=42,
            generate_report=False,
        )
        runner = VendingBenchRunner(config)

        report = await runner.run_benchmark()

        # Should complete without crashing
        assert len(report.results) == 2
        # Runs should end early due to bankruptcy
        for result in report.results:
            assert result.simulation_days < 30


class TestLeaderboardComparison:
    """Test leaderboard comparison functionality."""

    def test_leaderboard_scores_loaded(self) -> None:
        """Test that leaderboard scores are available."""
        assert len(LEADERBOARD_SCORES) > 0
        assert "grok_4" in LEADERBOARD_SCORES
        assert LEADERBOARD_SCORES["grok_4"].top_score > Decimal("4000")

    @pytest.mark.asyncio
    async def test_comparison_ranking(self) -> None:
        """Test ranking against leaderboard."""
        config = VendingBenchConfig(
            num_runs=1,
            max_days_per_run=5,
            random_seed=42,
            generate_report=False,
            compare_leaderboard=True,
        )
        runner = VendingBenchRunner(config)

        report = await runner.run_benchmark()

        # Our score should be ranked appropriately
        comparison = report.leaderboard_comparison
        assert comparison is not None

        # If our score is lower than all leaderboard entries,
        # we should be ranked last
        our_score = comparison.our_score
        all_scores = [entry.top_score for entry in LEADERBOARD_SCORES.values()]

        if our_score < min(all_scores):
            assert comparison.our_rank == len(LEADERBOARD_SCORES) + 1


class TestReportOutput:
    """Test report output functionality."""

    @pytest.mark.asyncio
    async def test_json_output_format(self) -> None:
        """Test JSON output format."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config = VendingBenchConfig(
                num_runs=1,
                max_days_per_run=3,
                random_seed=42,
                output_dir=tmpdir,
                generate_report=True,
            )
            runner = VendingBenchRunner(config)

            report = await runner.run_benchmark()
            results_dict = runner._report_to_dict(report)

            # Check required fields
            assert "metadata" in results_dict
            assert "config" in results_dict
            assert "metrics" in results_dict
            assert "results" in results_dict
            assert "summary" in results_dict

    @pytest.mark.asyncio
    async def test_markdown_report_generation(self) -> None:
        """Test markdown report is generated."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config = VendingBenchConfig(
                num_runs=1,
                max_days_per_run=3,
                random_seed=42,
                output_dir=tmpdir,
                generate_report=True,
            )
            runner = VendingBenchRunner(config)

            await runner.run_benchmark()

            # Check markdown file exists
            output_path = Path(tmpdir)
            md_files = list(output_path.glob("*.md"))
            assert len(md_files) >= 1

            # Check markdown content
            md_content = md_files[0].read_text()
            assert "# Vending-Bench" in md_content
            assert "Executive Summary" in md_content
            assert "Performance Metrics" in md_content

    @pytest.mark.asyncio
    async def test_detailed_logs_output(self) -> None:
        """Test detailed logs are generated when enabled."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config = VendingBenchConfig(
                num_runs=1,
                max_days_per_run=2,
                random_seed=42,
                output_dir=tmpdir,
                generate_report=True,
                save_detailed_logs=True,
            )
            runner = VendingBenchRunner(config)

            await runner.run_benchmark()

            output_path = Path(tmpdir)
            detailed_files = list(output_path.glob("vending-bench-detailed-*.json"))
            assert len(detailed_files) == 1

            data = json.loads(detailed_files[0].read_text())
            assert isinstance(data, dict)
            assert "results" in data
