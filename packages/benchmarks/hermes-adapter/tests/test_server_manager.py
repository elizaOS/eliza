"""Tests for ``hermes_adapter.server_manager.HermesAgentManager``."""

from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from hermes_adapter.server_manager import HermesAgentManager


def _fake_completed(rc: int = 0, stdout: str = "ok\n", stderr: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=["python"], returncode=rc, stdout=stdout, stderr=stderr)


@pytest.fixture
def fake_venv(tmp_path: Path) -> Path:
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
        mock_run.return_value = _fake_completed(rc=0, stdout="ok\n")
        mgr.start()
    assert mgr.is_running() is True
    assert mock_run.call_count == 1


def test_manager_start_raises_when_venv_unhealthy(fake_venv: Path) -> None:
    mgr = HermesAgentManager(repo_path=fake_venv, mode="subprocess")
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(rc=1, stderr="ImportError: hermes-agent")
        with pytest.raises(RuntimeError, match="not ready"):
            mgr.start()
    assert mgr.is_running() is False


def test_manager_start_idempotent(fake_venv: Path) -> None:
    mgr = HermesAgentManager(repo_path=fake_venv, mode="subprocess")
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(rc=0)
        mgr.start()
        mgr.start()
    # Second start should not trigger another subprocess call.
    assert mock_run.call_count == 1


def test_manager_stop_resets_state(fake_venv: Path) -> None:
    mgr = HermesAgentManager(repo_path=fake_venv, mode="subprocess")
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(rc=0)
        mgr.start()
    mgr.stop()
    assert mgr.is_running() is False


def test_manager_in_process_mode_skips_probe(fake_venv: Path) -> None:
    mgr = HermesAgentManager(repo_path=fake_venv, mode="in_process")
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mgr.start()
    assert mgr.is_running() is True
    assert mock_run.call_count == 0


def test_manager_exposes_client(tmp_path: Path) -> None:
    mgr = HermesAgentManager(repo_path=tmp_path)
    assert mgr.client is not None
    assert mgr.client.repo_path == tmp_path
