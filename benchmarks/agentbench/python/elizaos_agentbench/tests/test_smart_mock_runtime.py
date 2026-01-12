"""
End-to-end harness validation using the deterministic SmartMockRuntime.

This ensures:
- adapters parse actions correctly
- environments step/evaluate correctly
- runner writes strictly JSON-serializable outputs (no default=str)
"""

import json
import tempfile
from pathlib import Path

import pytest

from elizaos_agentbench.mock_runtime import SmartMockRuntime
from elizaos_agentbench.runner import AgentBenchRunner
from elizaos_agentbench.types import AgentBenchConfig, AgentBenchEnvironment, EnvironmentConfig


@pytest.mark.asyncio
async def test_smart_mock_runtime_end_to_end() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        config = AgentBenchConfig(
            output_dir=tmpdir,
            save_detailed_logs=True,
            enable_memory_tracking=False,
            use_docker=False,
            enable_baseline_comparison=False,
        )

        # Enable implemented environments with 1 task each
        config.os_config = EnvironmentConfig(
            enabled=True,
            max_tasks=1,
            additional_settings={"use_docker": False},
        )
        config.db_config = EnvironmentConfig(enabled=True, max_tasks=1)
        config.kg_config = EnvironmentConfig(enabled=True, max_tasks=1)
        config.web_shopping_config = EnvironmentConfig(enabled=True, max_tasks=1)
        config.lateral_thinking_config = EnvironmentConfig(enabled=True, max_tasks=1)

        # Disable unimplemented environments
        config.card_game_config = EnvironmentConfig(enabled=False)
        config.householding_config = EnvironmentConfig(enabled=False)
        config.web_browsing_config = EnvironmentConfig(enabled=False)

        runner = AgentBenchRunner(config=config, runtime=SmartMockRuntime())
        report = await runner.run_benchmarks()

        assert report.total_tasks == 5
        assert report.passed_tasks == 5
        assert report.failed_tasks == 0
        assert report.overall_success_rate == 1.0

        # Strict JSON outputs should exist and be parseable
        results_path = Path(tmpdir) / "agentbench-results.json"
        detailed_path = Path(tmpdir) / "agentbench-detailed.json"
        report_path = Path(tmpdir) / "agentbench-report.md"

        assert results_path.exists()
        assert detailed_path.exists()
        assert report_path.exists()

        with open(results_path, "r", encoding="utf-8") as f:
            results_json = json.load(f)
        assert results_json["total_tasks"] == 5
        assert results_json["passed_tasks"] == 5

        with open(detailed_path, "r", encoding="utf-8") as f:
            detailed_json = json.load(f)
        assert isinstance(detailed_json, list)
        assert len(detailed_json) == 5

