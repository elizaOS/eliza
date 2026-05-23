from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import validate_asimov1_real_agent_readiness as readiness  # noqa: E402


def _fake_step(name: str, *, passed: bool = True) -> dict:
    return {
        "name": name,
        "argv": [],
        "returncode": 0 if passed else 2,
        "stdout": "{}",
        "stderr": "",
        "passed": passed,
        "parsed": {},
    }


def test_real_agent_readiness_contract_passes_without_production_requirements(
    monkeypatch,
) -> None:
    calls: list[str] = []

    def fake_run(name: str, argv: list[str], *, cwd: Path = readiness.ROOT) -> dict:
        calls.append(name)
        return _fake_step(name)

    monkeypatch.setattr(readiness, "_run", fake_run)

    report = readiness.validate_asimov1_real_agent_readiness(max_steps=3)

    assert report["ok"] is True
    assert report["production_ready"] is False
    assert calls == [
        "server_command_surface",
        "real_bridge_dry_run",
        "real_prereqs",
        "policy_loop",
    ]


def test_real_agent_readiness_requires_production_and_hardware_when_requested(
    monkeypatch,
    tmp_path: Path,
) -> None:
    calls: list[str] = []

    def fake_run(name: str, argv: list[str], *, cwd: Path = readiness.ROOT) -> dict:
        calls.append(name)
        return _fake_step(name, passed=name != "real_hardware_evidence")

    monkeypatch.setattr(readiness, "_run", fake_run)

    report = readiness.validate_asimov1_real_agent_readiness(
        checkpoint=tmp_path / "checkpoint",
        hardware_evidence=tmp_path / "hardware.json",
        require_production=True,
        require_hardware=True,
    )

    assert report["ok"] is False
    assert report["checks"]["production_checkpoint"] is True
    assert report["checks"]["real_hardware_evidence"] is False
    assert calls[-2:] == ["production_checkpoint", "real_hardware_evidence"]


def test_real_agent_readiness_reports_production_ready_with_both_artifacts(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        readiness,
        "_run",
        lambda name, argv, cwd=readiness.ROOT: _fake_step(name),
    )

    report = readiness.validate_asimov1_real_agent_readiness(
        checkpoint=tmp_path / "checkpoint",
        hardware_evidence=tmp_path / "hardware.json",
        require_production=True,
        require_hardware=True,
    )

    assert report["ok"] is True
    assert report["production_ready"] is True
