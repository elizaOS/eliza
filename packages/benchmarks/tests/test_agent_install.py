"""Tests for ``lib.agent_install``.

All subprocess calls are mocked -- no real network or filesystem mutation
outside of the per-test ``tmp_path``.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from unittest import mock

import pytest


# Make the package importable when pytest is invoked from the benchmarks dir.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture
def isolated_agent_root(tmp_path, monkeypatch):
    """Force ``AGENT_ROOT`` into a tmp dir and reload the module."""
    monkeypatch.setenv("ELIZA_AGENTS_ROOT", str(tmp_path))
    import importlib

    import lib.agent_install as agent_install

    importlib.reload(agent_install)
    assert agent_install.AGENT_ROOT == tmp_path
    return agent_install, tmp_path


def _completed(returncode: int = 0, stdout: str = "", stderr: str = ""):
    return subprocess.CompletedProcess(
        args=["mock"], returncode=returncode, stdout=stdout, stderr=stderr
    )


def test_manifest_roundtrip(isolated_agent_root):
    agent_install, tmp_path = isolated_agent_root

    record = agent_install.InstalledAgent(
        agent_id="openclaw",
        version="2026.5.7",
        install_path=tmp_path / "openclaw" / "2026.5.7",
        binary_path=tmp_path / "openclaw" / "2026.5.7" / "node_modules" / ".bin" / "openclaw",
        env={"FOO": "bar"},
    )

    agent_install.write_manifest(record)
    path = agent_install.manifest_path("openclaw")
    assert path.is_file()

    raw = json.loads(path.read_text())
    assert raw["agent_id"] == "openclaw"
    assert raw["version"] == "2026.5.7"
    assert raw["env"] == {"FOO": "bar"}
    assert "installed_at" in raw

    loaded = agent_install.read_manifest("openclaw")
    assert loaded == record


def test_read_manifest_missing_returns_none(isolated_agent_root):
    agent_install, _ = isolated_agent_root
    assert agent_install.read_manifest("openclaw") is None


def test_read_manifest_invalid_returns_none(isolated_agent_root):
    agent_install, _ = isolated_agent_root
    path = agent_install.manifest_path("openclaw")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json", encoding="utf-8")
    assert agent_install.read_manifest("openclaw") is None


def test_install_openclaw_idempotent(isolated_agent_root):
    agent_install, tmp_path = isolated_agent_root

    prefix = tmp_path / "openclaw" / "2026.5.7"
    binary = prefix / "node_modules" / ".bin" / "openclaw"

    def fake_run(cmd, *args, **kwargs):
        # `npm view` resolves "latest" -> a concrete version.
        if cmd[:2] == ["npm", "view"]:
            return _completed(stdout="2026.5.7\n")
        # `npm install` -> create the binary file the installer expects.
        if cmd[:2] == ["npm", "install"]:
            binary.parent.mkdir(parents=True, exist_ok=True)
            binary.write_text("#!/usr/bin/env node\n")
            binary.chmod(0o755)
            return _completed()
        raise AssertionError(f"unexpected command: {cmd}")

    with mock.patch.object(subprocess, "run", side_effect=fake_run) as mocked:
        first = agent_install.install_openclaw("latest")
    assert first.agent_id == "openclaw"
    assert first.version == "2026.5.7"
    assert first.binary_path == binary
    # `npm view` + `npm install` => 2 calls on first run.
    assert mocked.call_count == 2

    # Second call with the resolved version must short-circuit on manifest+binary.
    with mock.patch.object(subprocess, "run") as mocked2:
        second = agent_install.install_openclaw("2026.5.7")
    assert second == first
    mocked2.assert_not_called()


def test_install_openclaw_force_reinstalls(isolated_agent_root):
    agent_install, tmp_path = isolated_agent_root

    prefix = tmp_path / "openclaw" / "2026.5.7"
    binary = prefix / "node_modules" / ".bin" / "openclaw"

    def fake_run(cmd, *args, **kwargs):
        if cmd[:2] == ["npm", "install"]:
            binary.parent.mkdir(parents=True, exist_ok=True)
            binary.write_text("#!/usr/bin/env node\n")
            binary.chmod(0o755)
            return _completed()
        raise AssertionError(f"unexpected command: {cmd}")

    # Seed an existing manifest for the same version.
    agent_install.write_manifest(
        agent_install.InstalledAgent(
            agent_id="openclaw",
            version="2026.5.7",
            install_path=prefix,
            binary_path=binary,
            env={},
        )
    )
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_text("old\n")

    with mock.patch.object(subprocess, "run", side_effect=fake_run) as mocked:
        result = agent_install.install_openclaw("2026.5.7", force=True)
    assert result.version == "2026.5.7"
    # With force, npm install must be invoked even though the manifest exists.
    assert any(c.args[0][:2] == ["npm", "install"] for c in mocked.mock_calls)


def test_install_openclaw_surfaces_npm_failure(isolated_agent_root):
    agent_install, _ = isolated_agent_root

    def fake_run(cmd, *args, **kwargs):
        return _completed(returncode=1, stdout="", stderr="ENOTFOUND registry")

    with mock.patch.object(subprocess, "run", side_effect=fake_run):
        with pytest.raises(agent_install.AgentInstallError) as excinfo:
            agent_install.install_openclaw("latest")
    assert "ENOTFOUND registry" in str(excinfo.value)


def test_verify_install_success_openclaw(isolated_agent_root):
    agent_install, tmp_path = isolated_agent_root

    prefix = tmp_path / "openclaw" / "2026.5.7"
    binary = prefix / "node_modules" / ".bin" / "openclaw"
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_text("#!/usr/bin/env node\n")
    binary.chmod(0o755)
    agent_install.write_manifest(
        agent_install.InstalledAgent(
            agent_id="openclaw",
            version="2026.5.7",
            install_path=prefix,
            binary_path=binary,
            env={},
        )
    )

    with mock.patch.object(
        subprocess, "run", return_value=_completed(stdout="openclaw v2026.5.7\n")
    ) as mocked:
        ok, detail = agent_install.verify_install("openclaw")
    assert ok is True
    assert "openclaw v2026.5.7" in detail
    cmd = mocked.call_args.args[0]
    assert cmd[0] == str(binary)
    assert "--version" in cmd


def test_verify_install_failure(isolated_agent_root):
    agent_install, tmp_path = isolated_agent_root

    prefix = tmp_path / "openclaw" / "2026.5.7"
    binary = prefix / "node_modules" / ".bin" / "openclaw"
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_text("#!/usr/bin/env node\n")
    binary.chmod(0o755)
    agent_install.write_manifest(
        agent_install.InstalledAgent(
            agent_id="openclaw",
            version="2026.5.7",
            install_path=prefix,
            binary_path=binary,
            env={},
        )
    )

    with mock.patch.object(
        subprocess,
        "run",
        return_value=_completed(returncode=1, stdout="", stderr="boom"),
    ):
        ok, detail = agent_install.verify_install("openclaw")
    assert ok is False
    assert "exit=1" in detail
    assert "boom" in detail


def test_verify_install_missing_manifest(isolated_agent_root):
    agent_install, _ = isolated_agent_root
    ok, detail = agent_install.verify_install("openclaw")
    assert ok is False
    assert "no manifest" in detail


def test_verify_install_unknown_agent(isolated_agent_root):
    agent_install, tmp_path = isolated_agent_root
    bogus_dir = tmp_path / "bogus"
    bogus_dir.mkdir(parents=True, exist_ok=True)
    bogus_bin = bogus_dir / "bin"
    bogus_bin.write_text("x")
    agent_install.write_manifest(
        agent_install.InstalledAgent(
            agent_id="bogus",
            version="0",
            install_path=bogus_dir,
            binary_path=bogus_bin,
            env={},
        )
    )
    ok, detail = agent_install.verify_install("bogus")
    assert ok is False
    assert "unknown agent_id" in detail


def test_install_all_unknown_agent(isolated_agent_root):
    agent_install, _ = isolated_agent_root
    with pytest.raises(agent_install.AgentInstallError) as excinfo:
        agent_install.install_all(["nonsense"])
    assert "unknown agent_id" in str(excinfo.value)


def test_cli_install_all_returns_zero_on_success(isolated_agent_root):
    agent_install, tmp_path = isolated_agent_root

    openclaw_prefix = tmp_path / "openclaw" / "2026.5.7"
    openclaw_bin = openclaw_prefix / "node_modules" / ".bin" / "openclaw"
    hermes_dir = tmp_path / agent_install.HERMES_DIR_NAME
    hermes_venv_python = hermes_dir / ".venv" / "bin" / "python"
    hermes_rev = "deadbeefcafe1234"

    def fake_run(cmd, *args, **kwargs):
        # OpenClaw install path.
        if cmd[:3] == ["npm", "view", "openclaw"]:
            return _completed(stdout="2026.5.7\n")
        if cmd[:2] == ["npm", "install"]:
            openclaw_bin.parent.mkdir(parents=True, exist_ok=True)
            openclaw_bin.write_text("#!/usr/bin/env node\n")
            openclaw_bin.chmod(0o755)
            return _completed()
        # Hermes install path.
        if cmd[0] == "git" and cmd[1] == "clone":
            hermes_dir.mkdir(parents=True, exist_ok=True)
            (hermes_dir / ".git").mkdir(exist_ok=True)
            return _completed()
        if cmd[:3] == ["git", "rev-parse", "HEAD"]:
            return _completed(stdout=f"{hermes_rev}\n")
        if cmd[1:4] == ["-m", "venv", ".venv"]:
            hermes_venv_python.parent.mkdir(parents=True, exist_ok=True)
            hermes_venv_python.write_text("#!/usr/bin/env python3\n")
            hermes_venv_python.chmod(0o755)
            return _completed()
        if cmd[1:5] == ["-m", "pip", "install", "-e"]:
            return _completed()
        # Verification calls.
        if cmd[0] == str(openclaw_bin) and "--version" in cmd:
            return _completed(stdout="openclaw v2026.5.7\n")
        if cmd[0] == str(hermes_venv_python) and "-c" in cmd:
            return _completed(stdout="ok\n")
        raise AssertionError(f"unexpected command: {cmd}")

    with mock.patch.object(subprocess, "run", side_effect=fake_run):
        rc = agent_install.cli(["--agents", "openclaw,hermes"])

    assert rc == 0
    op = agent_install.read_manifest("openclaw")
    assert op is not None and op.version == "2026.5.7"
    he = agent_install.read_manifest("hermes")
    assert he is not None and he.version == hermes_rev


def test_cli_verify_only_failure_returns_one(isolated_agent_root):
    agent_install, _ = isolated_agent_root
    # No manifests written -- verify-only must fail.
    rc = agent_install.cli(["--agents", "openclaw", "--verify-only"])
    assert rc == 1


def test_cli_empty_agents_returns_one(isolated_agent_root):
    agent_install, _ = isolated_agent_root
    rc = agent_install.cli(["--agents", "  ,  "])
    assert rc == 1
