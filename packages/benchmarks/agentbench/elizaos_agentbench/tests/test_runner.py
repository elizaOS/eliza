"""
Tests for AgentBench runner.
"""

import json
import tempfile
from pathlib import Path

import pytest

from elizaos_agentbench import upstream_loader
from elizaos_agentbench.cli import create_parser, run_benchmark
from elizaos_agentbench.runner import AgentBenchRunner, MemoryTracker, run_agentbench
from elizaos_agentbench.types import (
    AgentBenchConfig,
    AgentBenchDataMode,
    AgentBenchEnvironment,
    AgentBenchFailureKind,
    AgentBenchInfrastructureError,
    AgentBenchResult,
    AgentBenchTask,
    EnvironmentConfig,
)


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
                data_mode=AgentBenchDataMode.FIXTURE,
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
                data_mode=AgentBenchDataMode.FIXTURE,
            )
            # Minimal configuration
            for env in AgentBenchEnvironment:
                env_config = config.get_env_config(env)
                env_config.enabled = False

            config.db_config = EnvironmentConfig(enabled=True, max_tasks=1)

            report = await run_agentbench(config=config)

            assert report is not None
            assert report.total_tasks > 0


class TestTaskLoadFailures:
    @pytest.mark.asyncio
    async def test_unsupported_os_protocol_fails_before_adapter_initialization(
        self, monkeypatch, tmp_path: Path
    ) -> None:
        config = AgentBenchConfig(
            output_dir=str(tmp_path),
            enable_memory_tracking=False,
            data_mode=AgentBenchDataMode.FULL,
        )
        for env in AgentBenchEnvironment:
            config.get_env_config(env).enabled = False
        config.os_config = EnvironmentConfig(enabled=True)
        runner = AgentBenchRunner(config=config)
        adapter = runner._create_adapter(AgentBenchEnvironment.OS, config.os_config)
        initialized = False

        async def initialize() -> None:
            nonlocal initialized
            initialized = True

        task = AgentBenchTask(
            id="os-test-start-only",
            environment=AgentBenchEnvironment.OS,
            description="Use the prepared service.",
            initial_state={"create": {}, "start": "service example start"},
            goal="Return ready.",
            max_steps=1,
            metadata={"evaluation": {"match": "ready"}},
        )
        monkeypatch.setattr(adapter, "initialize", initialize)
        monkeypatch.setattr(runner, "_create_adapter", lambda *_args: adapter)
        monkeypatch.setattr(runner, "_load_tasks", lambda _env: [task])

        with pytest.raises(AgentBenchInfrastructureError, match="refusing partial"):
            await runner.run_benchmarks()
        assert initialized is False

    @pytest.mark.asyncio
    async def test_full_all_selection_refuses_partial_eight_environment_run(
        self, tmp_path: Path
    ) -> None:
        args = create_parser().parse_args(
            [
                "run",
                "--runtime",
                "hermes",
                "--data-mode",
                "full",
                "--split",
                "test",
                "--output",
                str(tmp_path),
            ]
        )

        assert await run_benchmark(args) == 1
        assert not (tmp_path / "agentbench-results.json").exists()

    @pytest.mark.asyncio
    async def test_auto_all_selection_is_also_refused_before_publication(
        self, tmp_path: Path
    ) -> None:
        args = create_parser().parse_args(
            [
                "run",
                "--runtime",
                "hermes",
                "--data-mode",
                "auto",
                "--output",
                str(tmp_path),
            ]
        )

        assert await run_benchmark(args) == 1
        assert not (tmp_path / "agentbench-results.json").exists()

    @pytest.mark.asyncio
    async def test_full_all_count_covers_exact_official_eight_environment_corpus(
        self,
        capsys,
    ) -> None:
        args = create_parser().parse_args(
            [
                "run",
                "--data-mode",
                "full",
                "--split",
                "test",
                "--count-scenarios",
                "--expand-scenarios",
            ]
        )

        assert await run_benchmark(args) == 0
        counts = json.loads(capsys.readouterr().out)
        assert len(counts) == 8
        assert sum(item["base"] for item in counts) == 1_264
        assert sum(item["edge"] for item in counts) == 12_640
        assert sum(item["total"] for item in counts) == 13_904
        assert {item["environment"] for item in counts} == {
            env.value for env in AgentBenchEnvironment
        }

    @pytest.mark.asyncio
    async def test_adapter_initialization_failure_is_not_silently_omitted(
        self, monkeypatch, tmp_path: Path
    ) -> None:
        config = AgentBenchConfig(
            output_dir=str(tmp_path),
            enable_memory_tracking=False,
            data_mode=AgentBenchDataMode.FIXTURE,
        )
        for env in AgentBenchEnvironment:
            config.get_env_config(env).enabled = False
        config.db_config = EnvironmentConfig(enabled=True, max_tasks=1)
        runner = AgentBenchRunner(config=config)

        async def fail_initialize() -> None:
            raise RuntimeError("database unavailable")

        adapter = runner._create_adapter(
            AgentBenchEnvironment.DATABASE,
            config.db_config,
        )
        monkeypatch.setattr(adapter, "initialize", fail_initialize)
        monkeypatch.setattr(runner, "_create_adapter", lambda *_args: adapter)

        with pytest.raises(RuntimeError, match="database unavailable"):
            await runner.run_benchmarks()

    @pytest.mark.asyncio
    async def test_task_harness_error_is_not_published_as_model_failure(
        self, monkeypatch, tmp_path: Path
    ) -> None:
        config = AgentBenchConfig(
            output_dir=str(tmp_path),
            enable_memory_tracking=False,
            data_mode=AgentBenchDataMode.FIXTURE,
        )
        for env in AgentBenchEnvironment:
            config.get_env_config(env).enabled = False
        config.db_config = EnvironmentConfig(enabled=True, max_tasks=1)
        runner = AgentBenchRunner(config=config)
        adapter = runner._create_adapter(
            AgentBenchEnvironment.DATABASE,
            config.db_config,
        )

        async def fail_task(_task: object) -> AgentBenchResult:
            return AgentBenchResult(
                task_id="db-fixture-test-0000",
                environment=AgentBenchEnvironment.DATABASE,
                success=False,
                steps_taken=0,
                actions=[],
                final_state={},
                duration_ms=1.0,
                error="fixture setup failed",
                failure_kind=AgentBenchFailureKind.INFRASTRUCTURE,
            )

        monkeypatch.setattr(adapter, "run_task", fail_task)
        monkeypatch.setattr(runner, "_create_adapter", lambda *_args: adapter)

        with pytest.raises(RuntimeError, match="fixture setup failed"):
            await runner.run_benchmarks()
        assert not (tmp_path / "agentbench-results.json").exists()

    @pytest.mark.asyncio
    async def test_scored_task_timeout_is_reported_without_aborting(
        self, monkeypatch, tmp_path: Path
    ) -> None:
        config = AgentBenchConfig(
            output_dir=str(tmp_path),
            enable_memory_tracking=False,
            data_mode=AgentBenchDataMode.FIXTURE,
        )
        for env in AgentBenchEnvironment:
            config.get_env_config(env).enabled = False
        config.db_config = EnvironmentConfig(enabled=True, max_tasks=1)
        runner = AgentBenchRunner(config=config)
        adapter = runner._create_adapter(AgentBenchEnvironment.DATABASE, config.db_config)

        async def timeout_task(_task: object) -> AgentBenchResult:
            return AgentBenchResult(
                task_id="db-fixture-test-0000",
                environment=AgentBenchEnvironment.DATABASE,
                success=False,
                steps_taken=1,
                actions=["think"],
                final_state={},
                duration_ms=1.0,
                error="Task timed out after 1ms",
                failure_kind=AgentBenchFailureKind.TASK,
            )

        monkeypatch.setattr(adapter, "run_task", timeout_task)
        monkeypatch.setattr(runner, "_create_adapter", lambda *_args: adapter)

        report = await runner.run_benchmarks()

        assert report.total_tasks == 1
        assert report.failed_tasks == 1
        detailed = json.loads((tmp_path / "agentbench-detailed.json").read_text())
        assert detailed[0]["failure_kind"] == "task"

    def test_zero_loaded_tasks_fail_fast_unless_allowed(self, monkeypatch) -> None:
        config = AgentBenchConfig(
            enable_memory_tracking=False,
            data_mode=AgentBenchDataMode.FIXTURE,
        )
        for env in AgentBenchEnvironment:
            config.get_env_config(env).enabled = False
        config.db_config = EnvironmentConfig(enabled=True, max_tasks=1)

        monkeypatch.setattr(upstream_loader, "load_tasks", lambda *args, **kwargs: [])
        runner = AgentBenchRunner(config=config)

        with pytest.raises(RuntimeError, match="loaded zero AgentBench tasks"):
            runner._load_tasks(AgentBenchEnvironment.DATABASE)

    def test_zero_loaded_tasks_allowed_for_dry_run(self, monkeypatch) -> None:
        config = AgentBenchConfig(
            enable_memory_tracking=False,
            data_mode=AgentBenchDataMode.FIXTURE,
            dry_run=True,
        )
        monkeypatch.setattr(upstream_loader, "load_tasks", lambda *args, **kwargs: [])
        runner = AgentBenchRunner(config=config)

        assert runner._load_tasks(AgentBenchEnvironment.DATABASE) == []
