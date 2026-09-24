"""Exercise standalone matrix and inventory commands outside the checkout cwd."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


@pytest.mark.parametrize("command", ["validate-matrix", "inventory"])
def test_repository_commands_resolve_their_own_checkout(command: str, tmp_path: Path) -> None:
    repository = Path(__file__).resolve().parents[3]
    env = os.environ.copy()
    env["PYTHONPATH"] = str(repository.parent)
    result = subprocess.run(
        [sys.executable, "-m", "benchmarks.orchestrator", command, "--format", "json"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, result.stderr + result.stdout
    report = json.loads(result.stdout)
    if command == "validate-matrix":
        assert report["cells"], "The command must produce adapter/harness decisions"
        assert report["error_count"] == 0
    else:
        assert report["adapter_count"] > 0


@pytest.mark.parametrize("smoke", [True, False])
def test_code_agent_preflight_requires_only_executed_adapter(tmp_path: Path, smoke: bool) -> None:
    repository = Path(__file__).resolve().parents[3]
    env = os.environ.copy()
    env["PYTHONPATH"] = str(repository.parent)
    env["OPENCODE_BIN"] = str(tmp_path / "absent-opencode")
    env.pop("CEREBRAS_API_KEY", None)
    command = [sys.executable, "-m", "benchmarks.orchestrator.code_agent_matrix",
               "--benchmarks", "webshop", "--adapters", "opencode", "--preflight",
               "--run-root", str(tmp_path / "run")]
    if smoke:
        command.append("--smoke")
    result = subprocess.run(command, cwd=tmp_path, env=env, capture_output=True,
                            text=True, timeout=60, check=False)
    report = json.loads(result.stdout)
    findings = {issue["kind"] for issue in report["issues"]}
    if smoke:
        assert result.returncode == 0, result.stderr + result.stdout
        assert report["ok"] is True
        assert findings == set()
    else:
        assert result.returncode == 2
        assert "missing_opencode_cli" in findings
        assert "missing_provider_key" in findings


def test_mixed_mock_and_live_cells_keep_opencode_prerequisite(tmp_path: Path) -> None:
    from benchmarks.orchestrator.code_agent_matrix import build_cell, preflight_matrix

    repository = Path(__file__).resolve().parents[3]
    cells = [build_cell(root=repository, run_root=tmp_path / str(smoke),
                        benchmark="webshop", adapter="opencode", provider="cerebras",
                        model="fixture-model", max_tasks=1, smoke=smoke, no_docker=True)
             for smoke in (True, False)]
    report = preflight_matrix(root=repository, cells=cells, provider="cerebras",
                              require_provider_key=False,
                              env={"OPENCODE_BIN": str(tmp_path / "absent-opencode")})
    assert report["ok"] is False
    assert [issue["kind"] for issue in report["issues"]] == ["missing_opencode_cli"]
