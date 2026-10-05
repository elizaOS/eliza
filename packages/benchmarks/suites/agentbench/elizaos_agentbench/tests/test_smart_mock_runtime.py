"""
End-to-end harness validation using the deterministic SmartMockRuntime.

This validates pipeline invariants (loader -> adapter -> runner ->
strict-JSON outputs). It does NOT assert success rates: the mock
runtime is a placeholder that emits valid actions but is not capable
of actually solving upstream AgentBench tasks. Real benchmark scores
require a real LLM agent (eliza/hermes/openclaw adapter).
"""

import json
import tempfile
from pathlib import Path

import pytest

from elizaos_agentbench.mock_runtime import SmartMockRuntime
from elizaos_agentbench.runner import AgentBenchRunner
from elizaos_agentbench.types import (
    AgentBenchConfig,
    BenchmarkSplit,
    EnvironmentConfig,
)


@pytest.mark.asyncio
async def test_smart_mock_runtime_end_to_end() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        config = AgentBenchConfig(
            output_dir=tmpdir,
            save_detailed_logs=True,
            enable_memory_tracking=False,
            use_docker=False,
            enable_baseline_comparison=False,
            split=BenchmarkSplit.DEV,
        )

        # Enable a few real envs with 1 task each from upstream's dev split.
        config.os_config = EnvironmentConfig(
            enabled=True, max_tasks=1, additional_settings={"use_docker": False}
        )
        config.db_config = EnvironmentConfig(enabled=True, max_tasks=1)
        config.kg_config = EnvironmentConfig(enabled=True, max_tasks=1)
        config.lateral_thinking_config = EnvironmentConfig(enabled=True, max_tasks=1)
        config.web_browsing_config = EnvironmentConfig(enabled=True, max_tasks=1)

        # Disable envs that need external deps (TextWorld, WebShop corpus,
        # Card Game native SDK) for this smoke test.
        config.web_shopping_config = EnvironmentConfig(enabled=False)
        config.card_game_config = EnvironmentConfig(enabled=False)
        config.householding_config = EnvironmentConfig(enabled=False)

        runner = AgentBenchRunner(config=config, runtime=SmartMockRuntime())
        report = await runner.run_benchmarks()

        # Pipeline invariants only - no success rate assertion.
        assert report.total_tasks == report.passed_tasks + report.failed_tasks
        assert 0.0 <= report.overall_success_rate <= 1.0
        assert report.total_tasks >= 5  # 5 enabled envs * 1 task each

        # Strict JSON outputs should exist and be parseable
        results_path = Path(tmpdir) / "agentbench-results.json"
        detailed_path = Path(tmpdir) / "agentbench-detailed.json"
        report_path = Path(tmpdir) / "agentbench-report.md"

        assert results_path.exists()
        assert detailed_path.exists()
        assert report_path.exists()

        with open(results_path, "r", encoding="utf-8") as f:
            results_json = json.load(f)
        assert "total_tasks" in results_json
        assert "environment_reports" in results_json

        with open(detailed_path, "r", encoding="utf-8") as f:
            detailed_json = json.load(f)
        assert isinstance(detailed_json, list)
        assert len(detailed_json) == report.total_tasks
