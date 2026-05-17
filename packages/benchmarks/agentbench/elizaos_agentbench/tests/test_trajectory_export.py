"""
Smoke tests for local AgentBench trajectory export.
"""

import json
import tempfile
from pathlib import Path

import pytest

from elizaos_agentbench.mock_runtime import SmartMockRuntime
from elizaos_agentbench.runner import AgentBenchRunner
from elizaos_agentbench.trajectory_integration import export_trajectories_from_results
from elizaos_agentbench.types import (
    AgentBenchConfig,
    AgentBenchDataMode,
    AgentBenchEnvironment,
    EnvironmentConfig,
)


@pytest.mark.asyncio
async def test_exports_art_trajectory_jsonl_from_detailed_results() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        config = AgentBenchConfig(
            output_dir=tmpdir,
            save_detailed_logs=True,
            enable_memory_tracking=False,
            enable_baseline_comparison=False,
            data_mode=AgentBenchDataMode.FIXTURE,
        )
        for env in AgentBenchEnvironment:
            config.get_env_config(env).enabled = False
        config.web_browsing_config = EnvironmentConfig(enabled=True, max_tasks=1)

        runner = AgentBenchRunner(config=config, runtime=SmartMockRuntime())
        report = await runner.run_benchmarks()
        assert report.total_tasks == 1

        export_path = export_trajectories_from_results(tmpdir, "art")
        assert export_path == Path(tmpdir) / "agentbench-trajectories-art.jsonl"
        assert export_path.exists()

        lines = export_path.read_text(encoding="utf-8").splitlines()
        assert len(lines) == 1
        record = json.loads(lines[0])
        assert record["id"].startswith("m2w-fixture-")
        assert record["environment"] == AgentBenchEnvironment.WEB_BROWSING.value
        assert isinstance(record["messages"], list)
