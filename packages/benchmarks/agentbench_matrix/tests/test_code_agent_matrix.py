from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def test_agentbench_matrix_cli_mock_outputs_summary(tmp_path: Path) -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = "packages:packages/benchmarks/agentbench"
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "benchmarks.agentbench_matrix.code_agent_matrix",
            "--task-agent",
            "opencode",
            "--output",
            str(tmp_path / "out"),
            "--trajectory-dir",
            str(tmp_path / "traj"),
            "--max-tasks",
            "1",
            "--mock",
            "--no-docker",
            "--json",
        ],
        cwd=Path(__file__).resolve().parents[3],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["benchmark"] == "agentbench"
    assert payload["adapter"] == "opencode"
    assert payload["summary"]["total_instances"] == 5
    assert payload["summary"]["resolved"] == 5.0
    assert payload["summary"]["resolve_rate"] == 1.0
    assert set(payload["environment_reports"]) == {
        "database",
        "knowledge_graph",
        "operating_system",
        "web_browsing",
        "web_shopping",
    }


def test_agentbench_matrix_cli_mock_expanded_scenarios(tmp_path: Path) -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = "packages:packages/benchmarks/agentbench"
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "benchmarks.agentbench_matrix.code_agent_matrix",
            "--task-agent",
            "opencode",
            "--output",
            str(tmp_path / "out"),
            "--max-tasks",
            "1",
            "--mock",
            "--expand-scenarios",
            "--no-docker",
            "--json",
        ],
        cwd=Path(__file__).resolve().parents[3],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["dataset_version"] == "agentbench-five-env-fixture-edge-v1"
    assert payload["summary"]["total_instances"] == 55
    assert payload["summary"]["resolved"] == 55.0
    assert payload["summary"]["resolve_rate"] == 1.0
