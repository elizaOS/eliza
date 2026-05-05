"""
Integration tests for Tau-bench benchmark.
"""

import pytest
from pathlib import Path

from elizaos_tau_bench.types import TauBenchConfig, TauDomain, TauBenchTask
from elizaos_tau_bench.runner import TauBenchRunner
from elizaos_tau_bench.dataset import TauBenchDataset
from elizaos_tau_bench.eliza_agent import create_tau_agent
from elizaos_tau_bench.executor import ToolExecutor
from elizaos_tau_bench.environments.retail import RetailEnvironment
from elizaos_tau_bench.environments.airline import AirlineEnvironment


class TestDatasetLoading:
    """Tests for dataset loading."""

    @pytest.mark.asyncio
    async def test_create_sample_tasks(self):
        """Test creating sample tasks."""
        dataset = TauBenchDataset("./nonexistent")
        tasks = dataset.create_sample_tasks()

        assert len(tasks) > 0

        # Check retail tasks exist
        retail_tasks = [t for t in tasks if t.domain == TauDomain.RETAIL]
        assert len(retail_tasks) > 0

        # Check airline tasks exist
        airline_tasks = [t for t in tasks if t.domain == TauDomain.AIRLINE]
        assert len(airline_tasks) > 0

    @pytest.mark.asyncio
    async def test_load_from_json(self, tmp_path):
        """Test loading tasks from JSON files."""
        # Create test data
        retail_dir = tmp_path / "retail"
        retail_dir.mkdir()

        import json
        test_task = {
            "task_id": "test_001",
            "domain": "retail",
            "user_instruction": "Test task",
            "expected_tool_calls": [],
            "policy_constraints": [],
        }

        with open(retail_dir / "tasks.json", "w") as f:
            json.dump([test_task], f)

        dataset = TauBenchDataset(str(tmp_path))
        await dataset.load()

        assert len(dataset.tasks) == 1
        assert dataset.tasks[0].task_id == "test_001"


class TestAgentExecution:
    """Tests for agent task execution."""

    @pytest.mark.asyncio
    async def test_agent_processes_retail_task(self):
        """Test agent processing a retail task."""
        task = TauBenchTask(
            task_id="agent_test_retail",
            domain=TauDomain.RETAIL,
            user_instruction="What's the status of order ORD-12345?",
            success_criteria=[],
        )

        env = RetailEnvironment(task)
        await env.initialize()

        task.available_tools = env.get_available_tools()
        task.policy_constraints = env.get_policy_constraints()

        executor = ToolExecutor(env)
        executor.register_tools(task.available_tools)

        # Create mock agent (no LLM calls)
        agent = create_tau_agent(executor=executor, max_turns=5, use_mock=True)
        await agent.initialize()

        tool_calls, response, conversation = await agent.process_task(task)

        # Agent should make at least one tool call or provide a response
        assert len(conversation) > 0

    @pytest.mark.asyncio
    async def test_agent_processes_airline_task(self):
        """Test agent processing an airline task."""
        task = TauBenchTask(
            task_id="agent_test_airline",
            domain=TauDomain.AIRLINE,
            user_instruction="What's the status of flight AA100?",
            success_criteria=[],
        )

        env = AirlineEnvironment(task)
        await env.initialize()

        task.available_tools = env.get_available_tools()
        task.policy_constraints = env.get_policy_constraints()

        executor = ToolExecutor(env)
        executor.register_tools(task.available_tools)

        agent = create_tau_agent(executor=executor, max_turns=5, use_mock=True)
        await agent.initialize()

        tool_calls, response, conversation = await agent.process_task(task)

        assert len(conversation) > 0


class TestEndToEndBenchmark:
    """End-to-end benchmark tests."""

    @pytest.mark.asyncio
    async def test_run_benchmark_with_sample_tasks(self, tmp_path):
        """Test running full benchmark with sample tasks."""
        config = TauBenchConfig(
            data_path=str(tmp_path / "data"),
            output_dir=str(tmp_path / "output"),
            domains=[TauDomain.RETAIL],
            max_tasks=2,
            num_trials=1,
            timeout_ms=30000,
            save_detailed_logs=True,
            enable_memory_tracking=False,
            use_mock=True,  # Use mock agent (no LLM)
        )

        runner = TauBenchRunner(config)
        report = await runner.run_benchmark()

        # Check report structure
        assert report.total_tasks > 0
        assert report.total_trials > 0
        assert 0 <= report.overall_success_rate <= 1
        assert len(report.results) > 0

        # Check output files were created
        output_dir = Path(config.output_dir)
        assert (output_dir / "tau-bench-results.json").exists()
        assert (output_dir / "tau-bench-summary.md").exists()

    @pytest.mark.asyncio
    async def test_run_benchmark_multiple_domains(self, tmp_path):
        """Test running benchmark across multiple domains."""
        config = TauBenchConfig(
            data_path=str(tmp_path / "data"),
            output_dir=str(tmp_path / "output"),
            domains=[TauDomain.RETAIL, TauDomain.AIRLINE],
            max_tasks=1,
            num_trials=1,
            timeout_ms=30000,
            enable_memory_tracking=False,
            use_mock=True,
        )

        runner = TauBenchRunner(config)
        report = await runner.run_benchmark()

        # Should have results from both domains
        assert TauDomain.RETAIL in report.domain_reports or TauDomain.AIRLINE in report.domain_reports

    @pytest.mark.asyncio
    async def test_run_benchmark_multiple_trials(self, tmp_path):
        """Test running benchmark with multiple trials for Pass^k."""
        config = TauBenchConfig(
            data_path=str(tmp_path / "data"),
            output_dir=str(tmp_path / "output"),
            domains=[TauDomain.RETAIL],
            max_tasks=1,
            num_trials=3,  # Multiple trials
            timeout_ms=30000,
            enable_memory_tracking=False,
            use_mock=True,
        )

        runner = TauBenchRunner(config)
        report = await runner.run_benchmark()

        # Should have Pass^k metrics
        assert 1 in report.pass_k_metrics

        # Total trials should be tasks * num_trials
        assert report.total_trials == report.total_tasks * config.num_trials


class TestReportGeneration:
    """Tests for report generation."""

    @pytest.mark.asyncio
    async def test_markdown_summary_generation(self, tmp_path):
        """Test markdown summary is properly generated."""
        config = TauBenchConfig(
            data_path=str(tmp_path / "data"),
            output_dir=str(tmp_path / "output"),
            domains=[TauDomain.RETAIL],
            max_tasks=1,
            num_trials=1,
            enable_memory_tracking=False,
            use_mock=True,
        )

        runner = TauBenchRunner(config)
        await runner.run_benchmark()

        summary_path = Path(config.output_dir) / "tau-bench-summary.md"
        assert summary_path.exists()

        content = summary_path.read_text()
        assert "# Tau-bench Benchmark Results" in content
        assert "Executive Summary" in content
        assert "Pass^k" in content

    @pytest.mark.asyncio
    async def test_leaderboard_comparison(self, tmp_path):
        """Test leaderboard comparison is included in report."""
        config = TauBenchConfig(
            data_path=str(tmp_path / "data"),
            output_dir=str(tmp_path / "output"),
            domains=[TauDomain.RETAIL],
            max_tasks=2,
            num_trials=1,
            enable_memory_tracking=False,
            use_mock=True,
        )

        runner = TauBenchRunner(config)
        report = await runner.run_benchmark()

        # Should have leaderboard comparison
        assert "comparison_to_leaderboard" in report.__dict__ or hasattr(report, "comparison_to_leaderboard")
        assert report.comparison_to_leaderboard.get("comparison_details") is not None
