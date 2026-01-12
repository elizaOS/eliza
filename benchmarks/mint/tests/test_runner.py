"""
Tests for MINT benchmark runner.
"""

import pytest

from benchmarks.mint.types import MINTConfig, MINTCategory
from benchmarks.mint.runner import MINTRunner


class TestMINTRunner:
    """Tests for MINTRunner class."""

    def test_runner_validates_max_turns(self) -> None:
        """Test that runner validates max_turns >= 1."""
        with pytest.raises(ValueError, match="max_turns must be at least 1"):
            config = MINTConfig(max_turns=0)
            MINTRunner(config=config)

    def test_runner_validates_timeout(self) -> None:
        """Test that runner validates timeout >= 1000ms."""
        with pytest.raises(ValueError, match="timeout_per_task_ms must be at least 1000"):
            config = MINTConfig(timeout_per_task_ms=500)
            MINTRunner(config=config)

    def test_runner_accepts_valid_config(self) -> None:
        """Test that runner accepts valid configuration."""
        config = MINTConfig(
            max_turns=5,
            timeout_per_task_ms=60000,
            use_docker=False,
        )
        runner = MINTRunner(config=config)
        assert runner.config.max_turns == 5
        assert runner.config.timeout_per_task_ms == 60000

    def test_runner_initializes_components(self) -> None:
        """Test that runner initializes all components."""
        config = MINTConfig(use_docker=False)
        runner = MINTRunner(config=config)

        assert runner.dataset is not None
        assert runner.executor is not None
        assert runner.feedback_generator is not None
        assert runner.agent is not None
        assert runner.evaluator is not None
        assert runner.metrics_calculator is not None
        assert runner.reporter is not None

    @pytest.mark.asyncio
    async def test_runner_requires_tasks(self) -> None:
        """Test that runner raises error if no tasks loaded."""
        config = MINTConfig(
            data_path="/nonexistent/path",
            use_docker=False,
            categories=[],  # Empty categories should result in no tasks
        )
        runner = MINTRunner(config=config)

        # Manually set empty tasks to simulate no data
        runner.dataset.tasks = {cat: [] for cat in MINTCategory}
        runner.dataset._loaded = True

        with pytest.raises(ValueError, match="No tasks loaded"):
            await runner.run_benchmark()
