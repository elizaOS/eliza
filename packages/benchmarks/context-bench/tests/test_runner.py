"""Tests for benchmark runner."""

import pytest

from elizaos_context_bench.runner import ContextBenchRunner
from elizaos_context_bench.types import (
    ContextBenchConfig,
    NeedlePosition,
)


class TestContextBenchRunner:
    """Tests for ContextBenchRunner class."""

    def test_runner_initialization(self) -> None:
        """Test runner initialization."""
        runner = ContextBenchRunner()
        assert runner.config is not None
        assert runner.niah_suite is not None
        assert runner.multihop_suite is not None

    def test_runner_with_custom_config(self) -> None:
        """Test runner with custom configuration."""
        config = ContextBenchConfig(
            context_lengths=[512, 1024],
            positions=[NeedlePosition.START, NeedlePosition.END],
            tasks_per_position=1,
        )
        runner = ContextBenchRunner(config=config)

        assert runner.config.context_lengths == [512, 1024]
        assert len(runner.config.positions) == 2

    def test_set_llm_query_fn(self) -> None:
        """Test setting LLM query function."""
        runner = ContextBenchRunner()

        async def mock_query(context: str, question: str) -> str:
            return "mock answer"

        runner.set_llm_query_fn(mock_query)

        assert runner.llm_query_fn is not None
        assert runner.niah_suite.llm_query_fn is not None
        assert runner.multihop_suite.llm_query_fn is not None


@pytest.mark.asyncio
class TestContextBenchRunnerAsync:
    """Async tests for ContextBenchRunner."""

    async def test_run_quick_eval(self) -> None:
        """Test quick evaluation run."""
        call_count = 0

        async def mock_query(context: str, question: str) -> str:
            nonlocal call_count
            call_count += 1
            # Return the expected answer pattern for fact needles
            return "TEST123"

        config = ContextBenchConfig(
            context_lengths=[512],  # Minimal for testing
            positions=[NeedlePosition.MIDDLE],
            tasks_per_position=1,
            run_niah_basic=True,
            run_niah_semantic=False,
            run_multi_hop=False,
        )

        runner = ContextBenchRunner(
            config=config,
            llm_query_fn=mock_query,
            seed=42,
        )

        results = await runner.run_quick_eval()

        assert results is not None
        assert results.metrics.total_tasks > 0
        assert call_count > 0

    async def test_run_position_sweep(self) -> None:
        """Test position sweep run."""
        async def mock_query(context: str, question: str) -> str:
            # Extract the expected answer from the context
            # For testing, just return a placeholder
            return "answer"

        config = ContextBenchConfig(
            context_lengths=[512],
            positions=[NeedlePosition.START, NeedlePosition.END],
            tasks_per_position=1,
        )

        runner = ContextBenchRunner(
            config=config,
            llm_query_fn=mock_query,
            seed=42,
        )

        results = await runner.run_position_sweep(
            context_lengths=[512],
            positions=[NeedlePosition.START],
        )

        assert results is not None
        assert results.metrics.total_tasks >= 1

    async def test_results_contain_comparison(self) -> None:
        """Test that results contain leaderboard comparison."""
        async def mock_query(context: str, question: str) -> str:
            return "answer"

        config = ContextBenchConfig(
            context_lengths=[512],
            positions=[NeedlePosition.MIDDLE],
            tasks_per_position=1,
            run_niah_semantic=False,
            run_multi_hop=False,
        )

        runner = ContextBenchRunner(
            config=config,
            llm_query_fn=mock_query,
            seed=42,
        )

        results = await runner.run_quick_eval()

        assert results.comparison_to_leaderboard is not None
        assert len(results.comparison_to_leaderboard) > 0

    async def test_results_contain_summary(self) -> None:
        """Test that results contain summary."""
        async def mock_query(context: str, question: str) -> str:
            return "answer"

        config = ContextBenchConfig(
            context_lengths=[512],
            positions=[NeedlePosition.MIDDLE],
            tasks_per_position=1,
            run_niah_semantic=False,
            run_multi_hop=False,
        )

        runner = ContextBenchRunner(
            config=config,
            llm_query_fn=mock_query,
            seed=42,
        )

        results = await runner.run_quick_eval()

        assert results.summary is not None
        assert "status" in results.summary
        assert "findings" in results.summary
