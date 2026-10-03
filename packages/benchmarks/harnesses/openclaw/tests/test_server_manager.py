"""Tests for ``openclaw_adapter.server_manager.OpenClawCLIManager``."""

from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from openclaw_adapter.client import OpenClawClient
from openclaw_adapter.server_manager import OpenClawCLIManager


def _fake_completed(
    rc: int = 0,
    stdout: str = "OpenClaw 2026.5.7 (eeef486)\n",
    stderr: str = "",
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=["openclaw"], returncode=rc, stdout=stdout, stderr=stderr
    )


@pytest.fixture
def fake_binary(tmp_path: Path) -> Path:
    binary = tmp_path / "openclaw"
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o755)
    return binary


def test_cli_manager_uses_client_path(fake_binary: Path) -> None:
    client = OpenClawClient(binary_path=fake_binary)
    mgr = OpenClawCLIManager(client=client)
    assert mgr.client is client
    assert mgr.install_path == fake_binary


def test_cli_manager_uses_install_path(fake_binary: Path) -> None:
    mgr = OpenClawCLIManager(install_path=fake_binary)
    assert mgr.install_path == fake_binary


def test_cli_manager_rejects_both_install_and_client(fake_binary: Path) -> None:
    with pytest.raises(ValueError):
        OpenClawCLIManager(
            install_path=fake_binary,
            client=OpenClawClient(binary_path=fake_binary),
        )


def test_cli_manager_start_runs_version_probe(fake_binary: Path) -> None:
    mgr = OpenClawCLIManager(install_path=fake_binary)
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed()
        mgr.start()
    assert mgr.is_running() is True
    cmd = mock_run.call_args.args[0]
    assert cmd == [str(fake_binary), "--version"]


def test_cli_manager_start_fails_when_binary_missing(tmp_path: Path) -> None:
    missing = tmp_path / "no-such-binary"
    mgr = OpenClawCLIManager(install_path=missing)
    with pytest.raises(FileNotFoundError) as excinfo:
        mgr.start()
    # The error message must contain the full path so operators can debug.
    assert str(missing) in str(excinfo.value)
    assert mgr.is_running() is False


def test_cli_manager_start_raises_when_version_fails(fake_binary: Path) -> None:
    mgr = OpenClawCLIManager(install_path=fake_binary)
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(rc=1, stderr="auth missing")
        with pytest.raises(RuntimeError, match="health probe failed"):
            mgr.start()
    assert mgr.is_running() is False


def test_cli_manager_start_idempotent(fake_binary: Path) -> None:
    mgr = OpenClawCLIManager(install_path=fake_binary)
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed()
        mgr.start()
        mgr.start()
    assert mock_run.call_count == 1


def test_cli_manager_stop_resets_state(fake_binary: Path) -> None:
    mgr = OpenClawCLIManager(install_path=fake_binary)
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed()
        mgr.start()
    mgr.stop()
    assert mgr.is_running() is False
