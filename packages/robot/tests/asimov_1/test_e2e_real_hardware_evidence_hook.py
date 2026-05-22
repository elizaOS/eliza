from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import validate_asimov1_e2e as e2e  # noqa: E402


def _fake_success_run(calls: list[str]):
    def fake_run(name: str, argv: list[str], *, cwd: Path = e2e.ROOT) -> dict:
        calls.append(name)
        stdout = ""
        if name == "bridge_targets":
            stdout = "asimov asimov_mock asimov-mujoco asimov_mujoco asimov-real asimov_remote"
        return {
            "name": name,
            "argv": argv,
            "returncode": 0,
            "stdout": stdout,
            "stderr": "",
            "passed": True,
            "parsed": {"ok": True},
        }

    return fake_run


def test_e2e_gate_validates_real_hardware_evidence_when_provided(
    monkeypatch,
    tmp_path: Path,
) -> None:
    evidence_path = tmp_path / "hardware.json"
    calls: list[str] = []
    monkeypatch.setattr(e2e, "_run", _fake_success_run(calls))

    report = e2e.run_asimov1_e2e(
        tmp_path / "out",
        steps=1,
        seed=7,
        real_hardware_evidence=evidence_path,
    )

    assert report["ok"] is True
    assert report["real_hardware_evidence"] == str(evidence_path.resolve())
    assert calls[-1] == "asimov_real_hardware_evidence"
    assert all(report["launch_checks"].values())
    evidence_step = report["steps"][-1]
    assert evidence_step["argv"][-1] == str(evidence_path.resolve())
    readiness_step = next(step for step in report["steps"] if step["name"] == "asimov_real_agent_readiness")
    assert "--hardware-evidence" in readiness_step["argv"]
    assert str(evidence_path.resolve()) in readiness_step["argv"]
    assert "--require-hardware" in readiness_step["argv"]


def test_e2e_gate_validates_production_checkpoint_when_provided(
    monkeypatch,
    tmp_path: Path,
) -> None:
    checkpoint_path = tmp_path / "checkpoint"
    calls: list[str] = []
    monkeypatch.setattr(e2e, "_run", _fake_success_run(calls))

    report = e2e.run_asimov1_e2e(
        tmp_path / "out",
        steps=1,
        seed=7,
        production_checkpoint=checkpoint_path,
        production_min_steps=123,
    )

    assert report["ok"] is True
    assert report["production_checkpoint"] == str(checkpoint_path.resolve())
    assert report["production_min_steps"] == 123
    assert calls[-1] == "asimov_production_checkpoint"
    assert all(report["launch_checks"].values())
    checkpoint_step = report["steps"][-1]
    assert checkpoint_step["argv"][-3:] == [
        str(checkpoint_path.resolve()),
        "--min-steps",
        "123",
    ]
    readiness_step = next(step for step in report["steps"] if step["name"] == "asimov_real_agent_readiness")
    assert "--checkpoint" in readiness_step["argv"]
    assert str(checkpoint_path.resolve()) in readiness_step["argv"]
    assert "--production-min-steps" in readiness_step["argv"]
    assert "123" in readiness_step["argv"]
    assert "--require-production" in readiness_step["argv"]


def test_e2e_gate_validates_workspace_promotion_when_provided(
    monkeypatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "edit-workspace"
    calls: list[str] = []
    monkeypatch.setattr(e2e, "_run", _fake_success_run(calls))

    report = e2e.run_asimov1_e2e(
        tmp_path / "out",
        steps=1,
        seed=7,
        workspace_promotion=workspace,
        require_promotion_applied=True,
    )

    assert report["ok"] is True
    assert report["workspace_promotion"] == str(workspace.resolve())
    assert report["require_promotion_applied"] is True
    assert calls[-1] == "asimov_workspace_promotion"
    promotion_step = report["steps"][-1]
    assert promotion_step["argv"][-3:] == [
        "--workspace",
        str(workspace.resolve()),
        "--require-applied",
    ]
    assert promotion_step["argv"][-1] == "--require-applied"
