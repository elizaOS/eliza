from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def test_mint_code_agent_cli_mock_outputs_matrix_summary(tmp_path: Path) -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = "packages:packages/benchmarks/eliza-adapter"
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "benchmarks.mint.code_agent_matrix",
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
    assert payload["benchmark"] == "mint"
    assert payload["adapter"] == "opencode"
    assert payload["summary"]["total_instances"] == 1
    assert payload["summary"]["resolved"] == 1
    assert payload["summary"]["resolve_rate"] == 1.0
    assert payload["results"][0]["subtask"] == "humaneval"


def test_mint_code_agent_cli_mock_expanded_count(tmp_path: Path) -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = "packages:packages/benchmarks/eliza-adapter"
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "benchmarks.mint.code_agent_matrix",
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
    assert payload["dataset_version"] == "mint-coding-edge-v1"
    assert payload["summary"]["total_instances"] == 11
    assert payload["summary"]["resolved"] == 11
