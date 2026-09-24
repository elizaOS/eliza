"""Tests for ``hermes_adapter.server_manager.HermesAgentManager``."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from hermes_adapter.server_manager import HermesAgentManager
from hermes_adapter.native_runtime import (
    HEALTH_TOOL_NAME,
    NATIVE_RUNTIME_API,
    NATIVE_RUNTIME_CLASS,
    NATIVE_TRANSPORT,
    PLUGIN_API,
    PLUGIN_ID,
    PLUGIN_TOOLSET,
)


def _fake_completed(
    rc: int = 0, stdout: str = "ok\n", stderr: str = ""
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=["python"], returncode=rc, stdout=stdout, stderr=stderr
    )


def _native_health(
    cmd: list[str], **kwargs: object
) -> subprocess.CompletedProcess[str]:
    payload = json.loads(str(kwargs.get("input") or "{}"))
    bridge = payload["bridge"]
    output = {
        "status": "ready",
        "agent_runtime": "hermes",
        "native_runtime_class": NATIVE_RUNTIME_CLASS,
        "native_runtime_api": NATIVE_RUNTIME_API,
        "native_runtime_module_file": str(Path(payload["repo_path"]) / "run_agent.py"),
        "native_agent_instantiated": True,
        "tool_bridge_plugin": PLUGIN_ID,
        "tool_bridge_api": PLUGIN_API,
        "tool_bridge_toolset": PLUGIN_TOOLSET,
        "tool_bridge_digest": bridge["digest"],
        "tool_bridge_loaded_tools": [HEALTH_TOOL_NAME],
        "tool_bridge_captured_calls": 0,
        "benchmark_workspace_path": payload["workspace_path"],
        "native_process_cwd": payload["workspace_path"],
        "transport": NATIVE_TRANSPORT,
        "hermes_home_isolated": True,
        "legacy_raw_openai_bypass": False,
        "publishable_native": True,
    }
    return _fake_completed(rc=0, stdout=json.dumps(output) + "\n")


@pytest.fixture
def fake_venv(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("CEREBRAS_BASE_URL", "http://127.0.0.1:8765/v1")
    venv_python = tmp_path / ".venv" / "bin" / "python"
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("# fake")
    venv_python.chmod(0o755)
    return tmp_path


def test_manager_rejects_unknown_mode(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        HermesAgentManager(repo_path=tmp_path, mode="banana")


def test_manager_start_runs_health_probe(fake_venv: Path) -> None:
    mgr = HermesAgentManager(repo_path=fake_venv, mode="subprocess")
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.side_effect = _native_health
        mgr.start()
    assert mgr.is_running() is True
    assert mock_run.call_count == 1


def test_manager_start_raises_when_venv_unhealthy(fake_venv: Path) -> None:
    mgr = HermesAgentManager(repo_path=fake_venv, mode="subprocess")
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(
            rc=1, stderr="ImportError: hermes-agent"
        )
        with pytest.raises(RuntimeError, match="not ready"):
            mgr.start()
    assert mgr.is_running() is False


def test_manager_start_idempotent(fake_venv: Path) -> None:
    mgr = HermesAgentManager(repo_path=fake_venv, mode="subprocess")
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.side_effect = _native_health
        mgr.start()
        mgr.start()
    # Second start should not trigger another subprocess call.
    assert mock_run.call_count == 1


def test_manager_stop_resets_state(fake_venv: Path) -> None:
    mgr = HermesAgentManager(repo_path=fake_venv, mode="subprocess")
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.side_effect = _native_health
        mgr.start()
    mgr.stop()
    assert mgr.is_running() is False


def test_manager_in_process_mode_is_nonpublishable(fake_venv: Path) -> None:
    mgr = HermesAgentManager(repo_path=fake_venv, mode="in_process")
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        with pytest.raises(RuntimeError, match="not ready"):
            mgr.start()
    assert mgr.is_running() is False
    assert mock_run.call_count == 0


def test_manager_exposes_client(tmp_path: Path) -> None:
    mgr = HermesAgentManager(repo_path=tmp_path)
    assert mgr.client is not None
    assert mgr.client.repo_path == tmp_path
