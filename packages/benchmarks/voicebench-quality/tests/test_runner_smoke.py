"""Smoke tests for fail-closed benchmark entry points."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def test_mock_mode_fails_closed(tmp_path: Path) -> None:
    cmd = [
        sys.executable,
        "-m",
        "elizaos_voicebench",
        "--suite",
        "openbookqa",
        "--limit",
        "1",
        "--mock",
        "--output",
        str(tmp_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    assert proc.returncode == 2
    assert "disabled" in proc.stderr.lower()
    assert not (tmp_path / "voicebench-quality-results.json").exists()


def test_fixtures_mode_fails_closed(tmp_path: Path) -> None:
    cmd = [
        sys.executable,
        "-m",
        "elizaos_voicebench",
        "--limit",
        "1",
        "--fixtures",
        "--output",
        str(tmp_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    assert proc.returncode == 2
    assert "disabled" in proc.stderr.lower()
    assert not (tmp_path / "voicebench-quality-results.json").exists()


def test_echo_agent_is_not_available(tmp_path: Path) -> None:
    cmd = [
        sys.executable,
        "-m",
        "elizaos_voicebench",
        "--agent",
        "echo",
        "--output",
        str(tmp_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    assert proc.returncode == 2
    assert "invalid choice" in proc.stderr.lower()
    assert not (tmp_path / "voicebench-quality-results.json").exists()


def test_parser_defaults_to_real_agent_and_stt() -> None:
    import elizaos_voicebench.__main__ as cli

    args = cli._build_parser().parse_args([])
    assert args.agent == "eliza"
    assert args.stt_provider == "groq"
    assert args.mock is False
    assert args.fixtures is False


def test_resolve_suites_all_keyword() -> None:
    from elizaos_voicebench.runner import resolve_suites
    from elizaos_voicebench.types import SUITES

    assert resolve_suites("all") == SUITES
    assert resolve_suites(None) == SUITES
    assert resolve_suites("openbookqa") == ("openbookqa",)
