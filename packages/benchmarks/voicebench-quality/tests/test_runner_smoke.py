"""Smoke test: end-to-end mock run with no network or API keys."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path


def test_smoke_openbookqa_mock(tmp_path: Path) -> None:
    cmd = [
        sys.executable,
        "-m",
        "elizaos_voicebench",
        "--suite",
        "openbookqa",
        "--limit",
        "2",
        "--mock",
        "--output",
        str(tmp_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    out_path = tmp_path / "voicebench-quality-results.json"
    assert out_path.exists(), result.stderr
    payload = json.loads(out_path.read_text())
    assert payload["agent"] == "echo"
    assert payload["suites_run"] == ["openbookqa"]
    assert payload["n"] == 2
    # Echo adapter returns sample.answer verbatim → 100% MCQ score.
    assert payload["score"] == 1.0
    assert payload["per_suite"]["openbookqa"] == 1.0


def test_smoke_all_suites_mock(tmp_path: Path) -> None:
    cmd = [
        sys.executable,
        "-m",
        "elizaos_voicebench",
        "--suite",
        "all",
        "--limit",
        "2",
        "--mock",
        "--output",
        str(tmp_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    out_path = tmp_path / "voicebench-quality-results.json"
    payload = json.loads(out_path.read_text())
    assert sorted(payload["per_suite"].keys()) == sorted(
        [
            "alpacaeval",
            "commoneval",
            "sd-qa",
            "ifeval",
            "advbench",
            "openbookqa",
            "mmsu",
            "bbh",
        ]
    )
    # Echo adapter: MCQ + ifeval-exact + alpacaeval/commoneval/sd-qa/bbh
    # (stub judge exact-match) all score 1.0. advbench scores 0.0 because
    # the echo of "" is not a refusal — the smoke test covers that the
    # refusal scorer fails closed when the agent doesn't refuse, which is
    # the correct behavior for a non-safety-aware echo.
    assert payload["score"] > 0.5
    assert payload["per_suite"]["openbookqa"] == 1.0
    assert payload["per_suite"]["advbench"] == 0.0


def test_fixtures_mode_keeps_selected_agent(monkeypatch, tmp_path: Path) -> None:
    import elizaos_voicebench.__main__ as cli
    from elizaos_voicebench.adapters import EchoAdapter
    from elizaos_voicebench.clients.judge import StubJudge

    captured: dict[str, object] = {}

    def fake_build_adapter(*, agent: str, stt_provider: str | None, mock: bool):
        captured["adapter"] = {
            "agent": agent,
            "stt_provider": stt_provider,
            "mock": mock,
        }
        return EchoAdapter()

    def fake_build_judge(*, mock: bool, model: str | None):
        captured["judge"] = {"mock": mock, "model": model}
        return StubJudge()

    monkeypatch.setattr(cli, "build_adapter", fake_build_adapter)
    monkeypatch.setattr(cli, "build_judge", fake_build_judge)

    args = cli._build_parser().parse_args(
        [
            "--suite",
            "openbookqa",
            "--limit",
            "1",
            "--fixtures",
            "--agent",
            "eliza",
            "--output",
            str(tmp_path),
        ]
    )

    assert asyncio.run(cli._run_async(args)) == 0
    payload = json.loads((tmp_path / "voicebench-quality-results.json").read_text())
    assert payload["agent"] == "eliza"
    assert captured["adapter"] == {
        "agent": "eliza",
        "stt_provider": None,
        "mock": False,
    }
    assert captured["judge"] == {"mock": False, "model": None}


def test_resolve_suites_all_keyword() -> None:
    from elizaos_voicebench.runner import resolve_suites
    from elizaos_voicebench.types import SUITES

    assert resolve_suites("all") == SUITES
    assert resolve_suites(None) == SUITES
    assert resolve_suites("openbookqa") == ("openbookqa",)
