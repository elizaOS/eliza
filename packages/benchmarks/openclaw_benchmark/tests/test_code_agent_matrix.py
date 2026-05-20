from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def test_openclaw_benchmark_cli_mock_outputs_matrix_summary(tmp_path: Path) -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = "packages:packages/benchmarks/openclaw-benchmark"
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "benchmarks.openclaw_benchmark.code_agent_matrix",
            "--task-agent",
            "opencode",
            "--output",
            str(tmp_path / "out"),
            "--trajectory-dir",
            str(tmp_path / "traj"),
            "--scenario",
            "setup",
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
    assert payload["benchmark"] == "openclaw_benchmark"
    assert payload["adapter"] == "opencode"
    assert payload["summary"]["total_instances"] == 1
    assert payload["summary"]["resolved"] == 1.0
    assert payload["results"][0]["task"] == "setup"
