from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from benchmarks.clawbench_matrix.code_agent_matrix import (
    count_scenarios,
    expand_scenarios,
    validate_scenarios,
)


def test_expand_scenarios_adds_ten_edge_variants() -> None:
    expanded = expand_scenarios(["setup"], expand=True)

    assert count_scenarios(["setup"], expand=True) == {"base": 1, "edge": 10, "total": 11}
    assert len(expanded) == 11
    assert expanded[1]["scenario"] == "setup__edge_01"
    assert expanded[1]["source_scenario"] == "setup"
    assert validate_scenarios(["setup"], expand=True)["valid"] is True


def test_clawbench_matrix_cli_mock_outputs_summary(tmp_path: Path) -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = "packages:packages/benchmarks/clawbench"
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "benchmarks.clawbench_matrix.code_agent_matrix",
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
            "--expand-scenarios",
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
    assert payload["benchmark"] == "clawbench"
    assert payload["adapter"] == "opencode"
    assert payload["scenario_counts"] == {"base": 1, "edge": 10, "total": 11}
    assert payload["summary"]["total_instances"] == 11
    assert payload["summary"]["resolved"] == 11.0
    assert payload["results"][0]["score"] == 1.0
