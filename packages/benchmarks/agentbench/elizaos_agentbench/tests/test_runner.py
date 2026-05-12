"""
Tests for AgentBench runner.
"""

import pytest
import tempfile
from pathlib import Path

from elizaos_agentbench.types import (
    AgentBenchConfig,
    AgentBenchEnvironment,
    EnvironmentConfig,
)
from elizaos_agentbench.runner import AgentBenchRunner, run_agentbench, MemoryTracker


class TestMemoryTracker:
    @pytest.mark.asyncio
    async def test_memory_tracking(self) -> None:
        """Test memory tracking functionality."""
        tracker = MemoryTracker(enabled=True)
        await tracker.start()

        # Do some work to use memory
        data = [i for i in range(10000)]
        _ = data

        await tracker.stop()
        stats = tracker.get_stats()

        assert "peak" in stats
        assert "average" in stats
        assert stats["peak"] >= 0

    @pytest.mark.asyncio
    async def test_disabled_tracker(self) -> None:
        """Test disabled memory tracking."""
        tracker = MemoryTracker(enabled=False)
        await tracker.start()
        await tracker.stop()
        stats = tracker.get_stats()

        assert stats["peak"] == 0
        assert stats["average"] == 0


class TestAgentBenchRunner:
    @pytest.fixture
    def config(self) -> AgentBenchConfig:
        """Create test configuration with limited scope."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config = AgentBenchConfig(
                output_dir=tmpdir,
                save_detailed_logs=True,
                enable_metrics=True,
                enable_memory_tracking=False,  # Disable for faster tests
                use_docker=False,
            )
            # Limit to a few environments for testing
            config.os_config = EnvironmentConfig(
                enabled=True,
                max_tasks=1,
                additional_settings={"use_docker": False},
            )
            config.db_config = EnvironmentConfig(enabled=True, max_tasks=1)
            config.kg_config = EnvironmentConfig(enabled=False)
            config.card_game_config = EnvironmentConfig(enabled=False)
            config.lateral_thinking_config = EnvironmentConfig(enabled=False)
            config.householding_config = EnvironmentConfig(enabled=False)
            config.web_shopping_config = EnvironmentConfig(enabled=False)
            config.web_browsing_config = EnvironmentConfig(enabled=False)
            yield config

    @pytest.mark.asyncio
    async def test_runner_creation(self, config: AgentBenchConfig) -> None:
        """Test runner initialization."""
        runner = AgentBenchRunner(config=config)
        assert runner.config == config
        assert runner.runtime is None

    @pytest.mark.asyncio
    async def test_get_enabled_environments(self, config: AgentBenchConfig) -> None:
        """Test getting enabled environments."""
        enabled = config.get_enabled_environments()
        assert AgentBenchEnvironment.OS in enabled
        assert AgentBenchEnvironment.DATABASE in enabled
        assert AgentBenchEnvironment.KNOWLEDGE_GRAPH not in enabled

    @pytest.mark.asyncio
    async def test_generate_os_tasks(self, config: AgentBenchConfig) -> None:
        """Test OS task generation."""
        runner = AgentBenchRunner(config=config)
        tasks = runner._load_tasks(AgentBenchEnvironment.OS)
        assert len(tasks) > 0
        assert all(t.environment == AgentBenchEnvironment.OS for t in tasks)

    @pytest.mark.asyncio
    async def test_generate_db_tasks(self, config: AgentBenchConfig) -> None:
        """Test database task generation."""
        runner = AgentBenchRunner(config=config)
        tasks = runner._load_tasks(AgentBenchEnvironment.DATABASE)
        assert len(tasks) > 0
        assert all(t.environment == AgentBenchEnvironment.DATABASE for t in tasks)

    @pytest.mark.asyncio
    async def test_run_benchmarks_generates_report(self) -> None:
        """Test that running benchmarks generates a valid report."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config = AgentBenchConfig(
                output_dir=tmpdir,
                enable_memory_tracking=False,
                use_docker=False,
            )
            # Only test DB adapter (fastest)
            for env in AgentBenchEnvironment:
                env_config = config.get_env_config(env)
                env_config.enabled = False

            config.db_config = EnvironmentConfig(enabled=True, max_tasks=1)

            runner = AgentBenchRunner(config=config)
            report = await runner.run_benchmarks()

            assert report.total_tasks > 0
            assert report.overall_success_rate >= 0
            assert report.overall_success_rate <= 1
            assert len(report.environment_reports) > 0

            # Check that files were created
            json_path = Path(tmpdir) / "agentbench-results.json"
            md_path = Path(tmpdir) / "agentbench-report.md"
            assert json_path.exists()
            assert md_path.exists()


class TestConvenienceFunction:
    @pytest.mark.asyncio
    async def test_run_agentbench_with_default_config(self) -> None:
        """Test running with default configuration."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config = AgentBenchConfig(
                output_dir=tmpdir,
                enable_memory_tracking=False,
            )
            # Minimal configuration
            for env in AgentBenchEnvironment:
                env_config = config.get_env_config(env)
                env_config.enabled = False

            config.db_config = EnvironmentConfig(enabled=True, max_tasks=1)

            report = await run_agentbench(config=config)

            assert report is not None
            assert report.total_tasks > 0
